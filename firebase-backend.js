(function () {
  const SDK_VERSION = "13.3.0";
  const PDF_CHUNK_SIZE = 768 * 1024;
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const CHUNKS_PER_BATCH = 8;
  const IMAGE_TYPES_BY_EXTENSION = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
  let backendPromise;

  function getSupportedFileType(file, section) {
    const extension = file?.name?.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
    const expectedType = extension === ".pdf"
      ? "application/pdf"
      : section === "exam-papers" ? IMAGE_TYPES_BY_EXTENSION[extension] : null;
    if (!expectedType) return null;
    if (file.type && file.type !== expectedType
      && !(expectedType === "application/pdf" && file.type === "application/x-pdf")) {
      return null;
    }
    return expectedType;
  }

  function isConfigured(config) {
    return Boolean(
      config
      && config.apiKey
      && config.authDomain
      && config.projectId
      && config.appId
      && !Object.values(config).some((value) => typeof value === "string" && value.startsWith("YOUR_")),
    );
  }

  async function createBackend(config, adminEmail) {
    if (!isConfigured(config)) return null;
    if (backendPromise) return backendPromise;

    backendPromise = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
      const [appSdk, authSdk, firestoreSdk] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
      ]);

      const app = appSdk.initializeApp(config, "your-study-corner");
      const auth = authSdk.getAuth(app);
      const database = firestoreSdk.getFirestore(app);
      await new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = authSdk.onAuthStateChanged(
          auth,
          () => {
            unsubscribe();
            resolve();
          },
          reject,
        );
      });

      const isAdmin = () => {
        const currentUser = auth.currentUser;
        return Boolean(
          currentUser
          && currentUser.emailVerified
          && currentUser.email
          && adminEmail
          && currentUser.email.toLocaleLowerCase() === adminEmail.toLocaleLowerCase(),
        );
      };
      const isAdminConfigured = () => (
        typeof adminEmail === "string"
        && adminEmail.includes("@")
        && !adminEmail.startsWith("YOUR_")
      );

      const getAllFiles = async () => {
        if (!auth.currentUser) return [];
        const snapshot = await firestoreSdk.getDocs(firestoreSdk.collection(database, "pdfs"));
        return snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter((file) => file.uploadStatus !== "uploading");
      };

      const deletePdfData = async (id) => {
        const pdfReference = firestoreSdk.doc(database, "pdfs", id);
        const chunks = await firestoreSdk.getDocs(
          firestoreSdk.collection(database, "pdfs", id, "chunks"),
        );
        if (chunks.docs.length > 499) {
          throw new Error("This file has too many data chunks to remove safely. Contact the admin.");
        }
        const batch = firestoreSdk.writeBatch(database);
        chunks.docs.forEach((chunk) => batch.delete(chunk.ref));
        batch.delete(pdfReference);
        await batch.commit();
      };

      const saveFile = async (file, section, subject, source, options = {}) => {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in before uploading a file.");
        const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
        reportProgress(0);
        const isAdminUpload = section === "revision" || section === "notes";
        if (isAdminUpload && !isAdmin()) {
          throw new Error("Only the configured Firebase admin can upload Revision or Handwritten PDFs.");
        }
        if (!file || typeof file.arrayBuffer !== "function" || !Number.isInteger(file.size)
          || file.size <= 0 || file.size > MAX_FILE_SIZE || typeof file.name !== "string") {
          throw new Error("Choose a file up to 25 MiB.");
        }
        const type = getSupportedFileType(file, section);
        if (!type) {
          throw new Error(section === "exam-papers"
            ? "Exam Papers accept PDFs, PNGs, and JPGs."
            : "Only PDF files can be added to this section.");
        }

        const id = options.id || crypto.randomUUID();
        const pdfReference = firestoreSdk.doc(database, "pdfs", id);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const chunkCount = Math.ceil(bytes.byteLength / PDF_CHUNK_SIZE);
        const record = {
          name: file.name,
          size: file.size,
          type,
          section,
          subject,
          source: source || "library",
          createdAt: options.createdAt || Date.now(),
          uploadedBy: user.uid,
          chunkCount,
          uploadStatus: "uploading",
        };

        let recordCreated = false;
        let uploadedBytes = 0;
        try {
          await firestoreSdk.runTransaction(database, async (transaction) => {
            const existing = await transaction.get(pdfReference);
            if (existing.exists()) throw new Error("A PDF with this ID is already in the shared library.");
            transaction.set(pdfReference, record);
          });
          recordCreated = true;

          for (let offset = 0; offset < chunkCount; offset += CHUNKS_PER_BATCH) {
            const batch = firestoreSdk.writeBatch(database);
            const batchEnd = Math.min(offset + CHUNKS_PER_BATCH, chunkCount);
            for (let index = offset; index < batchEnd; index += 1) {
              const start = index * PDF_CHUNK_SIZE;
              const end = Math.min(start + PDF_CHUNK_SIZE, bytes.byteLength);
              const chunkReference = firestoreSdk.doc(
                database,
                "pdfs",
                id,
                "chunks",
                String(index),
              );
              batch.set(chunkReference, {
                index,
                content: firestoreSdk.Bytes.fromUint8Array(bytes.slice(start, end)),
                uploadedBy: user.uid,
              });
            }
            await batch.commit();
            for (let index = offset; index < batchEnd; index += 1) {
              uploadedBytes += Math.min(PDF_CHUNK_SIZE, bytes.byteLength - index * PDF_CHUNK_SIZE);
            }
            reportProgress(Math.min(99, Math.round((uploadedBytes / bytes.byteLength) * 100)));
          }

          await firestoreSdk.updateDoc(pdfReference, { uploadStatus: "ready" });
          reportProgress(100);
        } catch (error) {
          if (recordCreated) {
            try {
              await deletePdfData(id);
            } catch (cleanupError) {
              console.error("Could not clean up an incomplete file upload:", cleanupError);
            }
          }
          throw error;
        }
        return { id, ...record, uploadStatus: "ready" };
      };

      const updatePdf = async (id, values) => {
        if (!auth.currentUser) throw new Error("Sign in before updating a file.");
        await firestoreSdk.updateDoc(firestoreSdk.doc(database, "pdfs", id), values);
      };

      const saveSubjects = async (sharedSubjects) => {
        if (!isAdmin()) throw new Error("Only the configured Firebase admin can update subjects.");
        await firestoreSdk.setDoc(
          firestoreSdk.doc(database, "settings", "library"),
          { subjects: sharedSubjects, updatedAt: Date.now() },
        );
      };

      return {
        auth,
        isAdmin,
        isAdminConfigured,
        signInStudent: async () => {
          if (!auth.currentUser) await authSdk.signInAnonymously(auth);
        },
        signInAdmin: async (email, password) => {
          if (!isAdminConfigured()) {
            throw new Error("Set the admin email in firebase-config.js and Firebase rules first.");
          }
          await authSdk.signInWithEmailAndPassword(auth, email, password);
          const currentUser = auth.currentUser;
          if (currentUser?.email
            && currentUser.email.toLocaleLowerCase() === adminEmail.toLocaleLowerCase()
            && !currentUser.emailVerified) {
            await authSdk.sendEmailVerification(currentUser);
            await authSdk.signOut(auth);
            await authSdk.signInAnonymously(auth);
            throw new Error("Check your email to verify the admin account, then sign in again.");
          }
          if (!isAdmin()) {
            await authSdk.signOut(auth);
            await authSdk.signInAnonymously(auth);
            throw new Error("This Firebase account is not authorized as the study-corner admin.");
          }
        },
        signOut: () => authSdk.signOut(auth),
        saveProfile: async (profile) => {
          if (!auth.currentUser) throw new Error("Sign in before saving your profile.");
          await firestoreSdk.setDoc(
            firestoreSdk.doc(database, "users", auth.currentUser.uid),
            { name: profile.name, batch: profile.batch, updatedAt: Date.now() },
            { merge: true },
          );
        },
        getAllFiles,
        watchLibrary: (onFiles, onSubjects, onError) => {
          if (!auth.currentUser) throw new Error("Sign in before syncing the shared library.");
          const stopFiles = firestoreSdk.onSnapshot(
            firestoreSdk.collection(database, "pdfs"),
            (snapshot) => onFiles(
              snapshot.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .filter((file) => file.uploadStatus !== "uploading"),
            ),
            onError,
          );
          const stopSubjects = firestoreSdk.onSnapshot(
            firestoreSdk.doc(database, "settings", "library"),
            (snapshot) => onSubjects(snapshot.exists() ? snapshot.data().subjects : null),
            onError,
          );
          return () => {
            stopFiles();
            stopSubjects();
          };
        },
        saveFile,
        getFileBlob: async (file) => {
          if (!auth.currentUser) throw new Error("Sign in to open this file.");
          if (file.storagePath) {
            const storageSdk = await import(`${base}/firebase-storage.js`);
            return storageSdk.getBlob(
              storageSdk.ref(storageSdk.getStorage(app), file.storagePath),
            );
          }
          const snapshot = await firestoreSdk.getDocs(
            firestoreSdk.collection(database, "pdfs", file.id, "chunks"),
          );
          const chunks = snapshot.docs
            .map((item) => item.data())
            .sort((left, right) => left.index - right.index);
          if (!Number.isInteger(file.chunkCount) || chunks.length !== file.chunkCount
            || chunks.some((chunk, index) => chunk.index !== index)) {
            throw new Error("This file is incomplete in the shared library. Ask the admin to publish it again.");
          }
          const parts = chunks.map((chunk) => chunk.content.toUint8Array());
          if (parts.reduce((size, part) => size + part.byteLength, 0) !== file.size) {
            throw new Error("This file failed its size check. Ask the admin to publish it again.");
          }
          return new Blob(parts, { type: file.type || "application/pdf" });
        },
        removeFile: async (file) => {
          if (!auth.currentUser) throw new Error("Sign in before removing a file.");
          if (!isAdmin()) throw new Error("Only the admin can remove files.");
          if (file.storagePath) {
            const storageSdk = await import(`${base}/firebase-storage.js`);
            await storageSdk.deleteObject(
              storageSdk.ref(storageSdk.getStorage(app), file.storagePath),
            );
          }
          await deletePdfData(file.id);
        },
        moveFileToSubject: async (file, subject) => {
          if (!auth.currentUser) throw new Error("Sign in before assigning a file.");
          if (!isAdmin()) throw new Error("Only the admin can assign PDFs to subjects.");
          await updatePdf(file.id, { subject });
        },
        removeSubject: async (subject, updatedSubjects) => {
          if (!isAdmin()) throw new Error("Only the configured Firebase admin can remove a subject.");
          const files = await firestoreSdk.getDocs(
            firestoreSdk.query(
              firestoreSdk.collection(database, "pdfs"),
              firestoreSdk.where("subject", "==", subject),
            ),
          );
          if (files.docs.length > 499) {
            throw new Error("This subject has too many files to move at once. Contact support before removing it.");
          }

          const batch = firestoreSdk.writeBatch(database);
          files.docs.forEach((item) => batch.update(item.ref, { subject: "Unassigned" }));
          batch.set(
            firestoreSdk.doc(database, "settings", "library"),
            { subjects: updatedSubjects, updatedAt: Date.now() },
            { merge: true },
          );
          await batch.commit();
        },
        getSubjects: async () => {
          if (!auth.currentUser) return null;
          const snapshot = await firestoreSdk.getDoc(firestoreSdk.doc(database, "settings", "library"));
          if (!snapshot.exists()) return null;
          const sharedSubjects = snapshot.data().subjects;
          if (!Array.isArray(sharedSubjects) || sharedSubjects.some((subject) => typeof subject !== "string")) {
            throw new Error("The shared subject list is invalid. Ask the admin to repair the library settings.");
          }
          return sharedSubjects;
        },
        saveSubjects,
        migrateLocalLibrary: async (localFiles, localSubjects) => {
          if (!isAdmin()) throw new Error("Only the configured Firebase admin can publish this device's library.");
          const currentSubjects = await (async () => {
            const snapshot = await firestoreSdk.getDoc(firestoreSdk.doc(database, "settings", "library"));
            return snapshot.exists() ? snapshot.data().subjects : null;
          })();
          if (!Array.isArray(currentSubjects) || currentSubjects.length === 0) {
            await saveSubjects(localSubjects);
          }

          const existingIds = new Set((await getAllFiles()).map((file) => file.id));
          let uploaded = 0;
          for (const file of localFiles) {
            if (existingIds.has(file.id)) continue;
            await saveFile(file.blob, file.section, file.subject, file.source, {
              id: file.id,
              createdAt: file.createdAt,
            });
            uploaded += 1;
          }
          return uploaded;
        },
        canManageFile: () => isAdmin(),
      };
    })();

    try {
      return await backendPromise;
    } catch (error) {
      backendPromise = null;
      throw error;
    }
  }

  window.StudyCornerFirebase = { createBackend, isConfigured };
})();

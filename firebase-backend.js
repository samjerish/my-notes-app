(function () {
  const SDK_VERSION = "13.3.0";
  let backendPromise;

  function isConfigured(config) {
    return Boolean(
      config
      && config.apiKey
      && config.authDomain
      && config.projectId
      && config.storageBucket
      && config.appId
      && !Object.values(config).some((value) => typeof value === "string" && value.startsWith("YOUR_")),
    );
  }

  async function createBackend(config, adminEmail) {
    if (!isConfigured(config)) return null;
    if (backendPromise) return backendPromise;

    backendPromise = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
      const [appSdk, authSdk, firestoreSdk, storageSdk] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
        import(`${base}/firebase-storage.js`),
      ]);

      const app = appSdk.initializeApp(config, "your-study-corner");
      const auth = authSdk.getAuth(app);
      const database = firestoreSdk.getFirestore(app);
      const storage = storageSdk.getStorage(app);
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
        return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      };

      const saveFile = async (file, section, subject, source, options = {}) => {
        const user = auth.currentUser;
        if (!user) throw new Error("Sign in before uploading a PDF.");
        const isAdminUpload = section === "revision" || section === "notes";
        if (isAdminUpload && !isAdmin()) {
          throw new Error("Only the configured Firebase admin can upload Revision or Handwritten PDFs.");
        }

        const id = options.id || crypto.randomUUID();
        const storagePath = isAdminUpload ? `pdfs/admin/${id}` : `pdfs/community/${user.uid}/${id}`;
        const storageReference = storageSdk.ref(storage, storagePath);
        const record = {
          name: file.name,
          size: file.size,
          type: "application/pdf",
          section,
          subject,
          source,
          storagePath,
          createdAt: options.createdAt || Date.now(),
          uploadedBy: user.uid,
        };

        await storageSdk.uploadBytes(storageReference, file, { contentType: "application/pdf" });
        try {
          await firestoreSdk.setDoc(firestoreSdk.doc(database, "pdfs", id), record);
        } catch (error) {
          try {
            await storageSdk.deleteObject(storageReference);
          } catch (cleanupError) {
            console.error("Could not clean up an unlisted uploaded PDF:", cleanupError);
          }
          throw error;
        }
        return { id, ...record };
      };

      const updatePdf = async (id, values) => {
        if (!auth.currentUser) throw new Error("Sign in before updating a PDF.");
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
            (snapshot) => onFiles(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
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
          if (!auth.currentUser) throw new Error("Sign in to open this PDF.");
          return storageSdk.getBlob(storageSdk.ref(storage, file.storagePath));
        },
        removeFile: async (file) => {
          if (!auth.currentUser) throw new Error("Sign in before removing a PDF.");
          const canManage = isAdmin() || (file.section === "contributed" && file.uploadedBy === auth.currentUser.uid);
          if (!canManage) throw new Error("Only the uploader or admin can remove this PDF.");
          await storageSdk.deleteObject(storageSdk.ref(storage, file.storagePath));
          await firestoreSdk.deleteDoc(firestoreSdk.doc(database, "pdfs", file.id));
        },
        moveFileToSubject: async (file, subject) => {
          if (!auth.currentUser) throw new Error("Sign in before assigning a PDF.");
          const canManage = isAdmin() || (file.section === "contributed" && file.uploadedBy === auth.currentUser.uid);
          if (!canManage) throw new Error("Only the uploader or admin can reassign this PDF.");
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
            throw new Error("This subject has too many PDFs to move at once. Contact support before removing it.");
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
        canManageFile: (file) => isAdmin()
          || Boolean(auth.currentUser && file.section === "contributed" && file.uploadedBy === auth.currentUser.uid),
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

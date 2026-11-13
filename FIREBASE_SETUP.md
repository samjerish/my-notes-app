# Firebase setup and deployment

The site now has a Firebase integration scaffold. It continues to show an explicitly labeled local preview until Firebase is configured; local PDFs are not automatically uploaded.

## 1. Create a Firebase project

1. Create a project in the [Firebase Console](https://console.firebase.google.com/).
2. Register a Web app and copy its Firebase web configuration into `firebase-config.js`.
3. Replace `YOUR_ADMIN_EMAIL` in `firebase-config.js`, `firestore.rules`, and `storage.rules` with the lowercase email used by the admin Firebase account.
4. In **Authentication → Sign-in method**, enable **Anonymous** and **Email/Password**.
5. In **Authentication → Users**, create the admin email/password account.
6. Create a Cloud Firestore database and a Cloud Storage bucket.

The Firebase Web API key and web-app config are intended to be present in browser code. Never put a Firebase Admin SDK private key or service-account JSON in this folder.

## 2. Install Firebase CLI and select the project

Install the Firebase CLI, then run these commands from this folder:

```sh
npm install -g firebase-tools
firebase login
firebase use --add
```

Select the project created above. The CLI writes the project selection locally; do not commit credentials or service-account files.

## 3. Deploy rules and host the site

```sh
firebase deploy --only firestore:rules,storage
firebase deploy --only hosting
```

Firebase Hosting provides a public `web.app` address after deployment. Add a custom domain later in **Hosting → Add custom domain** if desired.

## 4. Admin and shared-library behavior

- Students enter their name and batch as before. Firebase Anonymous Authentication gives each browser a signed-in identity; the shared library is available across devices, but name/batch profiles are not recoverable accounts.
- Anyone signed in can read shared PDFs and upload a contribution. Contributions are immediately visible to all signed-in users.
- Revision and Handwritten uploads, subject changes, and publishing a device's existing local PDFs require the configured admin email account, in addition to the existing code prompt.
- The code prompt is only a user-interface check. Firestore and Storage rules enforce admin access.
- The admin can use **Admin sign in** in the profile menu. The admin account must use the configured email.
- To share PDFs already stored in this browser, sign in as admin, use **Publish this device's PDFs**, review the confirmation, and approve. Local copies remain in this browser. This action can publish the current local subjects and PDFs.

## 5. Storage and limits

The security rules currently cap each PDF at 25 MiB. Firebase Storage and Firestore usage may incur charges if project quotas are exceeded. Review Firebase billing and usage limits before sharing the public URL widely.

The app retrieves PDFs through Firebase Storage's authenticated blob API. Replace the project ID placeholders in `storage-cors.json`, then apply the CORS settings to the Storage bucket with Google Cloud SDK:

```sh
gsutil cors set storage-cors.json gs://YOUR_STORAGE_BUCKET
```

Add any custom domain to the CORS `origin` list before using it.

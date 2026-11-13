# Firebase setup and deployment

The Firebase web-app configuration is in place for project `notes-app-25197`. Authentication and Cloud Firestore are enabled; Firestore is in `asia-south1` (Mumbai). The hosted app at https://notes-app-25197.web.app stores shared PDF bytes in Firestore chunks, avoiding the Cloud Storage Blaze-plan requirement. The app listens for Firestore changes in real time, so shared PDFs and subjects update automatically for signed-in users. PDFs added to **Your Contribution** from any signed-in device are uploaded to the shared library. PDFs saved only in a browser's local library must still be published by the admin.

## 1. Firebase services and admin account

1. Open the Firebase project `notes-app-25197` in the [Firebase Console](https://console.firebase.google.com/).
2. The configured admin email is `sf920336@gmail.com`; the app and Firestore rules are configured for this address.
3. **Authentication → Sign-in method** has **Anonymous** and **Email/Password** enabled.
4. Create an Email/Password admin account for that email under **Authentication → Users**. Set its password privately in Firebase Console; do not share it in chat or commit it. The admin must verify the email address before using admin functions; the app sends a verification link on the first sign-in if needed.
5. Cloud Firestore is already created in `asia-south1` (Mumbai).

The Firebase Web API key and web-app config are intended to be present in browser code. Never put a Firebase Admin SDK private key or service-account JSON in this folder.

## 2. Install Firebase CLI and authenticate

Install the Firebase CLI and authenticate, then deploy from this folder. `.firebaserc` already selects `notes-app-25197`:

```sh
npm install -g firebase-tools
firebase login
```

Do not commit Firebase CLI credentials or service-account files.

## 3. Deploy Firestore rules and host the site

```sh
firebase deploy --only firestore:rules,hosting
```

Firebase Hosting provides a public `web.app` address after deployment. Add a custom domain later in **Hosting → Add custom domain** if desired.

## 4. Admin and shared-library behavior

- Students enter their name and batch as before. Firebase Anonymous Authentication gives each browser a signed-in identity; the shared library is available across devices, but name/batch profiles are not recoverable accounts.
- Anyone signed in on the hosted site can read shared PDFs, upload a contribution, and send feedback. Firestore listeners deliver completed uploads and subject changes to other signed-in devices automatically; devices need an internet connection and the hosted HTTPS site.
- Only the verified admin account (`sf920336@gmail.com`) sees subject add/remove controls and can add Revision or Handwritten PDFs. The admin profile displays as Sam, batch 3. Admin-only actions also require the existing code prompt.
- Normal users do not see subject add/remove or PDF delete controls. They can contribute PDFs and send feedback. A contributor may not delete or reassign a published contribution; the admin can manage shared PDFs.
- The code prompt is only a user-interface check. Firestore rules enforce admin access.
- The admin can use **Admin sign in** in the profile menu after entering the library. This uses the verified Firebase admin email/password, not the student name/batch fields; after sign-in, the profile displays Sam, batch 3.
- To share PDFs already stored in this browser, sign in as admin, use **Publish this device's PDFs**, review the confirmation, and approve. Local copies remain in this browser. This action can publish the current local subjects and PDFs.

## 5. Firestore PDF storage and limits

Each PDF is capped at 25 MiB and split into 768 KiB Firestore documents. Uploads use multiple Firestore writes, and opening a PDF reads its chunks. Firestore free-tier storage and operation quotas still apply; this is not unlimited file storage. Monitor usage in Firebase Console and avoid publishing large libraries without reviewing current quotas.

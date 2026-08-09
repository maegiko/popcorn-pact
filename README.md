# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Authentication setup

Popcorn Pact offers **Sign in with Apple** as the primary option and email/password as
the fallback. The email flow works with no extra configuration. The Apple flow is fully
implemented in the app but **cannot complete a sign-in until the external configuration
below is done** — the button will render and open the Apple sheet, then fail at the token
exchange.

### ⚠️ Placeholder bundle identifier

`app.json` currently sets:

```json
"ios": { "bundleIdentifier": "com.popcornpact.app" }
```

This is a **placeholder**. It must match the App ID registered in the Apple Developer
portal, and the same string must be listed in Supabase. Change it in all three places
together before the first EAS build.

### 1. Apple Developer portal

Requires enrolment in the Apple Developer Program ($99/year).

1. **Certificates, Identifiers & Profiles → Identifiers → +** — register an App ID using
   your real bundle identifier.
2. Enable the **Sign in with Apple** capability on that App ID.
3. Leave the server-to-server notification endpoint blank; Supabase does not use it.

Native-only sign-in needs **no Services ID and no signing key**. Those are only required
if a browser-based Apple flow is added later (for example, on web).

### 2. Supabase dashboard

1. **Authentication → Providers → Apple** — enable the provider.
2. **Client IDs** — add your bundle identifier. To test in Expo Go, also add
   `host.exp.Exponent`, because Expo Go issues tokens under its own bundle identifier.
3. Leave the OAuth **Secret Key** blank. No redirect URL is needed: the app authenticates
   with a native identity token and never opens a browser.

### 3. Database

The `profiles` migration in `supabase/migrations/` must be applied, or every signed-in
user will land on the profile-load error screen.

```bash
npx supabase db reset   # local (requires Docker)
npx supabase db push    # hosted project
```

### Testing notes

- Apple sign-in is **iOS-only**. Android and web show the email form as the only option.
- Expo Go supports the module on iOS, but issues different identifiers than a standalone
  build — hence the `host.exp.Exponent` entry above.
- Use a real device signed into iCloud where possible; the simulator does not behave
  identically.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

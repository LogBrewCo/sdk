# SDK Setup Picker Guidance

Use this guidance when a product UI needs a short list of LogBrew SDK setup choices. The picker should show user-facing runtime or platform families, not helper package names.

## Top-Level Choices

Recommended order:

1. Web Browser (JavaScript)
2. Node.js
3. React
4. Next.js
5. React Native
6. Python
7. Go
8. Java
9. .NET
10. PHP
11. Ruby
12. Rust
13. iOS / Swift
14. Android / Kotlin
15. Unity
16. C
17. C++

These choices map to public setup paths that users can choose directly. They should lead to the smallest package or source path that can send first useful telemetry for that runtime or platform.

If a UI already offers Web Browser and Node.js, do not also show a vague `JavaScript` choice as a competing first step. Use `JavaScript (core)` only as an advanced/library option or as install-screen detail for the shared `@logbrew/sdk` package.

## Framework Variants

Keep framework adapters out of the first picker unless the UI has an advanced framework step after the user picks a runtime.

Suggested grouping:

- Web Browser: Angular, Vue, Svelte, and browser React.
- Node.js: Express, Fastify, and NestJS.
- React: Next.js can be shown as a high-demand top-level shortcut and also documented as a React/web framework variant.
- Python: FastAPI and Django.
- .NET: ASP.NET Core.
- Android / Kotlin: OkHttp and Kotlin/JVM request helpers.
- iOS / Swift: Objective-C and mixed Swift/Objective-C advanced setup.

The framework path should still install only what that app needs. Do not imply that every helper package is required for the base SDK.

## Platform Families

Treat Swift and Objective-C as one Apple app family. The top-level label should be `iOS / Swift` for iOS-focused flows or `Apple / Swift` when the flow covers macOS, tvOS, and watchOS too. SwiftPM `LogBrew` is the primary install path; Objective-C is an advanced source/header variant for mixed or Objective-C-only apps.

Treat Kotlin and Android as one Android/Kotlin family for mobile setup. Use `Android / Kotlin` as the top-level label. Kotlin/JVM and OkHttp helpers can appear under framework or advanced variants when the user is not building an Android app.

ASP.NET Core is a .NET framework integration, not a separate first-step SDK product. Show it after `.NET` is selected unless a product flow deliberately exposes framework shortcuts.

## Naming Rules

- Prefer runtime and platform labels over package names.
- Use package names only on the install-command screen.
- Avoid showing both `JavaScript` and `Web Browser (JavaScript)` as equal first-step choices unless the product explains the difference.
- Keep Objective-C, OkHttp, ASP.NET Core, FastAPI, Django, Express, Fastify, NestJS, Angular, Vue, and Svelte as variants unless the UI is explicitly showing framework shortcuts.
- Use placeholder SDK keys only in examples.
- Do not show backend routes or API contracts as live setup behavior unless the SDK docs say that path is ready.

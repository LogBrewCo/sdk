# Apple SDK Platform Grouping - 2026-06-23

## Goal

Decide how LogBrew should label Apple app setup paths when Swift and Objective-C are both supported.

## Competitor Sources Read

- Sentry Cocoa `getsentry/sentry-cocoa@809ca17ba3b480a7b7ca1b0c7f77bc8ab2d1ca08`
- Files read: `README.md`, `Package.swift`
- Pattern: Sentry presents one official Apple SDK for iOS, iPadOS, tvOS, macOS, watchOS, and visionOS. The README shows Swift and Objective-C initialization under the same SDK surface. `Package.swift` exposes the primary `Sentry` product and additional Objective-C-oriented products from the same package.

- Datadog iOS `DataDog/dd-sdk-ios@9a17d2cecf40c7ba7b2b1d55f7a37c14d20cdccf`
- Files read: `README.md`, `Package.swift`
- Pattern: Datadog describes one iOS/tvOS SDK with Swift and Objective-C libraries. Its SwiftPM package is one Apple package with multiple signal products such as `DatadogCore`, `DatadogLogs`, `DatadogTrace`, and `DatadogRUM`.

- PostHog iOS `PostHog/posthog-ios@6e70aa24bbd3778182fe039f7f5800a17674a6d6`
- Files read: `README.md`, `Package.swift`
- Pattern: PostHog presents one iOS SDK and one `PostHog` SwiftPM product while keeping an Objective-C example in the same public repo. Objective-C is a usage variant, not a separate top-level platform.

## LogBrew Decision

Use one top-level Apple app surface in setup/docs/pickers, preferably `iOS / Swift` when the product flow is iOS-specific and `Apple / Swift` when the flow covers macOS, tvOS, watchOS, or visionOS. Keep Objective-C visible as an advanced or legacy setup variant for mixed or Objective-C-only apps.

This matches the competitor pattern while preserving LogBrew's current packaging reality:

- Swift is the primary Apple path through the root SwiftPM `LogBrew` product, which points at `swift/logbrew-swift`.
- Objective-C is currently a separate dependency-light source/header package in `objc/logbrew-objc`, not the primary SwiftPM install path.

## Tradeoffs

- Better for users: fewer first-step choices and the common Apple app path starts with Swift/SwiftPM.
- Better than hiding Objective-C: mixed and legacy apps can still find the source/header variant.
- Current gap: LogBrew does not yet provide one SwiftPM package that exposes both Swift and Objective-C variants like Sentry does. Until packaging changes, docs should avoid implying Objective-C is installed through the Swift package.

## Follow-Up

- If the public repo later adds an XCFramework-style artifact or Objective-C product under the same Apple package, revisit whether Objective-C should become a product variant under the same Apple setup.
- Keep setup examples clear that SDK ingest uses project-scoped placeholder SDK keys only.

## 2026-06-23 Root SwiftPM Follow-Up

The repository root now includes a minimal SwiftPM manifest for the documented URL install path. It exposes the `LogBrew` library product from `swift/logbrew-swift/Sources/LogBrew` and runs the existing Swift tests from `swift/logbrew-swift/Tests/LogBrewTests`. This closes the first-install gap for SwiftPM users while keeping Objective-C as an advanced source/header variant.

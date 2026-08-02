using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;

namespace LogBrew
{
    internal static class IssueDiagnosticsTests
    {
        internal static int Run()
        {
            ManualDiagnosticsSerializeWithBoundsAndStableOrdering();
            ExceptionProjectionIsTypedBoundedAndPrivacySafe();
            InvalidDiagnosticsFailClosed();
            return 3;
        }

        private static void ManualDiagnosticsSerializeWithBoundsAndStableOrdering()
        {
            var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-issue-tests", "0.1.0");
            client.Issue(
                "evt_issue_diagnostics",
                "2026-08-02T08:15:31Z",
                IssueAttributes.Create("Checkout failed", "fatal")
                    .WithException(
                        IssueExceptionInfo.Create("CheckoutFailure")
                            .WithMechanism(IssueExceptionMechanism.Create("dotnet.manual", true)))
                    .WithStackFrame(
                        IssueStackFrame.Create(@"C:\workspace\app\CheckoutService.cs?debug=true#frame", 42, 7)
                            .WithFunction("SubmitAsync")
                            .WithModule("Checkout.Api.CheckoutService")
                            .WithInApp(true)
                            .WithDebugId("550E8400-E29B-41D4-A716-446655440000"))
                    .WithBreadcrumb(
                        IssueBreadcrumb.Create("2026-08-02T08:15:29.123Z", "checkout.request")
                            .WithType("http")
                            .WithLevel("warn")
                            .WithMessage("payment retry started")
                            .WithData(new Dictionary<string, object?>
                            {
                                ["attempt"] = 2,
                                ["cached"] = false,
                                ["region"] = "global"
                            }))
                    .WithBreadcrumb(
                        IssueBreadcrumb.Create("2026-08-02T08:15:30+00:00", "checkout.response")
                            .WithLevel("error"))
                    .WithBreadcrumbsTruncated(true));

            var preview = client.PreviewJson();
            foreach (var expected in new[]
            {
                "\"level\": \"critical\"",
                "\"exception\"",
                "\"type\": \"CheckoutFailure\"",
                "\"mechanism\"",
                "\"type\": \"dotnet.manual\"",
                "\"handled\": true",
                "\"stackFrames\"",
                "\"filename\": \"CheckoutService.cs\"",
                "\"line\": 42",
                "\"column\": 7",
                "\"function\": \"SubmitAsync\"",
                "\"module\": \"Checkout.Api.CheckoutService\"",
                "\"inApp\": true",
                "\"debugId\": \"550e8400-e29b-41d4-a716-446655440000\"",
                "\"breadcrumbs\"",
                "\"level\": \"warning\"",
                "\"attempt\": 2",
                "\"cached\": false",
                "\"breadcrumbsTruncated\": true"
            })
            {
                Require(preview.Contains(expected, StringComparison.Ordinal), "missing issue diagnostic field: " + expected);
            }

            Require(!preview.Contains("C:\\workspace", StringComparison.Ordinal), "absolute frame path must be reduced to a basename");
            Require(!preview.Contains("debug=true", StringComparison.Ordinal), "frame query text must be omitted");
            var first = preview.IndexOf("checkout.request", StringComparison.Ordinal);
            var second = preview.IndexOf("checkout.response", StringComparison.Ordinal);
            Require(first >= 0 && second > first, "breadcrumbs must preserve oldest-to-newest order");
        }

        private static void ExceptionProjectionIsTypedBoundedAndPrivacySafe()
        {
            Exception captured;
            try
            {
                ThrowProjectedException();
                throw new InvalidOperationException("expected projected exception");
            }
            catch (InvalidOperationException error) when (error.Message == "sensitive payment details")
            {
                captured = error;
            }

            var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-exception-tests", "0.1.0");
            client.Issue(
                "evt_issue_exception",
                "2026-08-02T08:15:31Z",
                IssueAttributes.FromException(captured));
            client.Issue(
                "evt_issue_unhandled",
                "2026-08-02T08:15:32Z",
                IssueAttributes.FromException(
                    captured,
                    "ASP.NET Core request failed",
                    "aspnetcore.middleware",
                    false));

            var preview = client.PreviewJson();
            Require(preview.Contains("\"title\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "default title must use stable exception type");
            Require(preview.Contains("\"type\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected structured exception type");
            Require(preview.Contains("\"type\": \"dotnet.exception\"", StringComparison.Ordinal), "expected default .NET mechanism");
            Require(preview.Contains("\"type\": \"aspnetcore.middleware\"", StringComparison.Ordinal), "expected explicit framework mechanism");
            Require(preview.Contains("\"handled\": false", StringComparison.Ordinal), "expected escaped exception handled state");
            Require(preview.Contains("\"stackFrames\"", StringComparison.Ordinal), "expected structured exception frames");
            Require(preview.Contains("\"function\": \"ThrowProjectedException\"", StringComparison.Ordinal), "expected projected function name");
            Require(preview.Contains("\"filename\": \"IssueDiagnosticsTests.cs\"", StringComparison.Ordinal), "expected basename-only projected filename");
            Require(!preview.Contains("sensitive payment details", StringComparison.Ordinal), "automatic projection must omit exception messages");
            Require(!preview.Contains("logbrew-dotnet-issue-diagnostics-cycle", StringComparison.Ordinal), "automatic projection must omit local paths");
            Require(CountOccurrences(preview, "\"filename\"") <= 64, "two projected exceptions must remain capped at 32 frames each");
        }

        private static void InvalidDiagnosticsFailClosed()
        {
            ExpectSdkError(
                "issue stack frame line must be a positive integer",
                () => Capture(IssueAttributes.Create("failure", "error")
                    .WithStackFrame(IssueStackFrame.Create("Checkout.cs", 0, 1))));
            ExpectSdkError(
                "issue stack frame debugId is invalid",
                () => Capture(IssueAttributes.Create("failure", "error")
                    .WithStackFrame(IssueStackFrame.Create("Checkout.cs", 1, 1).WithDebugId("not-a-debug-id"))));
            ExpectSdkError(
                "issue exception mechanism type must be a stable machine name",
                () => Capture(IssueAttributes.Create("failure", "error")
                    .WithException(
                        IssueExceptionInfo.Create("CheckoutFailure")
                            .WithMechanism(IssueExceptionMechanism.Create("dotnet.١", true)))));
            ExpectSdkError(
                "issue breadcrumb timestamp must be RFC 3339",
                () => Capture(IssueAttributes.Create("failure", "error")
                    .WithBreadcrumb(IssueBreadcrumb.Create("2026-08-02T08:15:30", "checkout"))));
            ExpectSdkError(
                "issue breadcrumb data value for nested must be a finite primitive",
                () => Capture(IssueAttributes.Create("failure", "error")
                    .WithBreadcrumb(IssueBreadcrumb.Create("2026-08-02T08:15:30Z", "checkout")
                        .WithData(new Dictionary<string, object?> { ["nested"] = new object() }))));
            ExpectSdkError(
                "issue stackFrames must contain 1-32 frames",
                () => IssueAttributes.Create("failure", "error").WithStackFrames(Array.Empty<IssueStackFrame>()));

            var frames = new List<IssueStackFrame>();
            for (var index = 0; index < 33; index++)
            {
                frames.Add(IssueStackFrame.Create("Checkout.cs", index + 1, 1));
            }
            ExpectSdkError(
                "issue stackFrames must contain 1-32 frames",
                () => IssueAttributes.Create("failure", "error").WithStackFrames(frames));

            var breadcrumbs = new List<IssueBreadcrumb>();
            for (var index = 0; index < 65; index++)
            {
                breadcrumbs.Add(IssueBreadcrumb.Create(
                    "2026-08-02T08:15:30Z",
                    "checkout.step" + index.ToString(CultureInfo.InvariantCulture)));
            }
            ExpectSdkError(
                "issue breadcrumbs must contain 1-64 entries",
                () => IssueAttributes.Create("failure", "error").WithBreadcrumbs(breadcrumbs));
        }

        private static void Capture(IssueAttributes attributes)
        {
            var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-invalid-issue-tests", "0.1.0");
            client.Issue("evt_issue_invalid", "2026-08-02T08:15:31Z", attributes);
        }

        private static void ExpectSdkError(string messageFragment, Action callback)
        {
            try
            {
                callback();
            }
            catch (SdkException error) when (error.Code == "validation_error")
            {
                Require(error.Message.Contains(messageFragment, StringComparison.Ordinal), "unexpected validation error: " + error.Message);
                return;
            }

            throw new InvalidOperationException("expected validation error containing " + messageFragment);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void ThrowProjectedException()
        {
            throw new InvalidOperationException("sensitive payment details");
        }

        private static int CountOccurrences(string text, string value)
        {
            var count = 0;
            var index = 0;
            while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += value.Length;
            }

            return count;
        }

        private static void Require(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }
    }

}

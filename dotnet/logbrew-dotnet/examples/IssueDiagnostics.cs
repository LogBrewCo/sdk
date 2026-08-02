using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using LogBrew;

public static class Program
{
    public static void Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet", "0.1.0");
        try
        {
            ThrowCheckoutFailure();
        }
        catch (InvalidOperationException error) when (error.Message == "private runtime detail")
        {
            client.Issue(
                "evt_issue_dotnet_diagnostics",
                "2026-08-02T08:15:31Z",
                IssueAttributes.FromException(
                        error,
                        "Checkout failed",
                        "dotnet.example",
                        true)
                    .WithBreadcrumb(
                        IssueBreadcrumb.Create("2026-08-02T08:15:29Z", "checkout.request")
                            .WithType("http")
                            .WithLevel("info")
                            .WithData(new Dictionary<string, object?> { ["attempt"] = 1 }))
                    .WithBreadcrumb(
                        IssueBreadcrumb.Create("2026-08-02T08:15:30Z", "checkout.retry")
                            .WithLevel("warn")
                            .WithData(new Dictionary<string, object?>
                            {
                                ["attempt"] = 2,
                                ["retryable"] = true
                            }))
                    .WithBreadcrumbsTruncated(true));
        }

        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine("{\"ok\":true,\"status\":" + response.StatusCode + ",\"events\":1}");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowCheckoutFailure()
    {
        throw new InvalidOperationException("private runtime detail");
    }
}

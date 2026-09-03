using Hangfire;
using LogBrew;
using LogBrew.Hangfire;

var client = LogBrewClient.CreateAutomatic(
    Environment.GetEnvironmentVariable("LOGBREW_SERVER_API_KEY")!,
    "checkout-worker",
    "1.0.0",
    new HttpTransport());

GlobalConfiguration.Configuration.UseLogBrewHangfire(client);

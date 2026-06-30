using System;
using System.Collections.Generic;
using LogBrew;
using LogBrew.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
var optionsBuilder = new DbContextOptionsBuilder();

optionsBuilder.AddLogBrewCommandTelemetry(
    client,
    options => options
        .WithEventIdPrefix("dotnet_efcore")
        .WithSystem("sqlserver")
        .WithDatabaseName("checkout")
        .WithOperationNamePrefix("orders")
        .WithMetadata(new Dictionary<string, object?> { ["feature"] = "checkout" })
        .WithCommandFilter(snapshot => snapshot.CommandSource != "migrations")
        .WithMetadataProvider(snapshot => new Dictionary<string, object?>
        {
            ["efCommandSource"] = snapshot.CommandSource,
            ["efExecuteMethod"] = snapshot.ExecuteMethod,
            ["efIsAsync"] = snapshot.IsAsync
        }));

Console.Error.WriteLine("{\"ok\":true,\"example\":\"EntityFrameworkCoreCommandTelemetry\"}");

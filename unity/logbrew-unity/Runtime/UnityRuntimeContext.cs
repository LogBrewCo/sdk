#nullable enable

using System;
using System.Reflection;

namespace LogBrew.Unity
{
    internal static class UnityRuntimeContext
    {
        internal static TelemetryContext Create(string gameName, bool includeRuntimeDetails)
        {
            var unityVersion = includeRuntimeDetails
                ? StaticString("UnityEngine.Application, UnityEngine.CoreModule", "unityVersion")
                : null;
            var productName = includeRuntimeDetails
                ? StaticString("UnityEngine.Application, UnityEngine.CoreModule", "productName") ?? gameName
                : gameName;
            var applicationVersion = includeRuntimeDetails
                ? StaticString("UnityEngine.Application, UnityEngine.CoreModule", "version")
                : null;
            var build = includeRuntimeDetails
                ? StaticString("UnityEngine.Application, UnityEngine.CoreModule", "buildGUID")
                : null;
            var platform = includeRuntimeDetails
                ? StaticValue("UnityEngine.Application, UnityEngine.CoreModule", "platform")
                : null;
            var resource = TelemetryResource.Create()
                .WithService(gameName)
                .WithFramework("unity", unityVersion)
                .WithApplication(productName, applicationVersion, build)
                .Build();
            var builder = TelemetryContext.Create().WithResource(resource);
            if (platform != null)
            {
                builder.WithTag("unity.platform", platform);
            }

            return builder.Build();
        }

        private static string? StaticString(string typeName, string propertyName)
        {
            return StaticValue(typeName, propertyName);
        }

        private static string? StaticValue(string typeName, string propertyName)
        {
            try
            {
                var type = Type.GetType(typeName, false);
                var property = type?.GetProperty(propertyName, BindingFlags.Public | BindingFlags.Static);
                var value = property?.GetValue(null, null)?.ToString();
                return SafeContextString(value);
            }
            catch (TargetInvocationException)
            {
                return null;
            }
            catch (MemberAccessException)
            {
                return null;
            }
            catch (TypeInitializationException)
            {
                return null;
            }
            catch (NotSupportedException)
            {
                return null;
            }
        }

        private static string? SafeContextString(string? value)
        {
            try
            {
                return TelemetryContextValue.OptionalString(value, "automatic Unity context");
            }
            catch (SdkException)
            {
                return null;
            }
        }
    }
}

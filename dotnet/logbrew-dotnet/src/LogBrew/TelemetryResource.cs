using System;
using System.Collections.Generic;

namespace LogBrew
{
    /// <summary>
    /// Immutable service, deployment, runtime, framework, device, and application identity.
    /// </summary>
    public sealed class TelemetryResource
    {
        private static readonly string[] SectionOrder =
        {
            "service",
            "deployment",
            "runtime",
            "framework",
            "operatingSystem",
            "device",
            "application"
        };
        private static readonly string[] NamedVersionFields = { "name", "version" };
        private static readonly string[] DeploymentFields = { "environment", "release" };
        private static readonly string[] OperatingSystemFields = { "name", "version", "build" };
        private static readonly string[] DeviceFields = { "family", "model", "architecture" };
        private static readonly string[] ApplicationFields = { "name", "version", "build" };

        private readonly Dictionary<string, Dictionary<string, string>> sections;

        private TelemetryResource(Dictionary<string, Dictionary<string, string>> sections)
        {
            this.sections = CopySections(sections);
        }

        /// <summary>Creates a builder for one bounded telemetry resource.</summary>
        public static Builder Create()
        {
            return new Builder();
        }

        internal static TelemetryResource? Merge(TelemetryResource? baseResource, TelemetryResource? overrideResource)
        {
            if (baseResource == null)
            {
                return overrideResource;
            }

            if (overrideResource == null)
            {
                return baseResource;
            }

            var merged = CopySections(baseResource.sections);
            foreach (var section in overrideResource.sections)
            {
                if (!merged.TryGetValue(section.Key, out var fields))
                {
                    fields = new Dictionary<string, string>(StringComparer.Ordinal);
                    merged[section.Key] = fields;
                }

                foreach (var field in section.Value)
                {
                    fields[field.Key] = field.Value;
                }
            }

            return new TelemetryResource(merged);
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var result = new OrderedJsonObject();
            foreach (var sectionName in SectionOrder)
            {
                if (!sections.TryGetValue(sectionName, out var fields))
                {
                    continue;
                }

                var section = new OrderedJsonObject();
                foreach (var fieldName in FieldsForSection(sectionName))
                {
                    if (fields.TryGetValue(fieldName, out var value))
                    {
                        section.Add(fieldName, value);
                    }
                }

                result.Add(sectionName, section);
            }

            return result;
        }

        private static string[] FieldsForSection(string sectionName)
        {
            switch (sectionName)
            {
                case "service":
                case "runtime":
                case "framework":
                    return NamedVersionFields;
                case "deployment":
                    return DeploymentFields;
                case "operatingSystem":
                    return OperatingSystemFields;
                case "device":
                    return DeviceFields;
                case "application":
                    return ApplicationFields;
                default:
                    return Array.Empty<string>();
            }
        }

        private static Dictionary<string, Dictionary<string, string>> CopySections(
            IDictionary<string, Dictionary<string, string>> source)
        {
            var copied = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
            foreach (var section in source)
            {
                copied[section.Key] = new Dictionary<string, string>(section.Value, StringComparer.Ordinal);
            }

            return copied;
        }

        /// <summary>Builds a non-empty immutable telemetry resource.</summary>
        public sealed class Builder
        {
            private readonly Dictionary<string, Dictionary<string, string>> sections =
                new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);

            internal Builder()
            {
            }

            /// <summary>Sets service name and optional version.</summary>
            public Builder WithService(string name, string? version = null)
            {
                sections["service"] = NamedVersion(name, version, "service");
                return this;
            }

            /// <summary>Sets deployment environment and optional release identity.</summary>
            public Builder WithDeployment(string? environment = null, string? release = null)
            {
                var deployment = new Dictionary<string, string>(StringComparer.Ordinal);
                AddOptional(deployment, "environment", TelemetryContextValue.OptionalString(environment, "deployment environment"));
                AddOptional(deployment, "release", TelemetryContextValue.OptionalString(release, "deployment release"));
                RequireNonEmptySection(deployment, "deployment");
                sections["deployment"] = deployment;
                return this;
            }

            /// <summary>Sets runtime name and optional version.</summary>
            public Builder WithRuntime(string name, string? version = null)
            {
                sections["runtime"] = NamedVersion(name, version, "runtime");
                return this;
            }

            /// <summary>Sets framework name and optional version.</summary>
            public Builder WithFramework(string name, string? version = null)
            {
                sections["framework"] = NamedVersion(name, version, "framework");
                return this;
            }

            /// <summary>Sets operating-system family and optional version and build.</summary>
            public Builder WithOperatingSystem(string name, string? version = null, string? build = null)
            {
                var operatingSystem = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["name"] = TelemetryContextValue.RequiredString(name, "operatingSystem name")
                };
                AddOptional(operatingSystem, "version", TelemetryContextValue.OptionalString(version, "operatingSystem version"));
                AddOptional(operatingSystem, "build", TelemetryContextValue.OptionalString(build, "operatingSystem build"));
                sections["operatingSystem"] = operatingSystem;
                return this;
            }

            /// <summary>Sets broad device family, model, and architecture values.</summary>
            public Builder WithDevice(string? family = null, string? model = null, string? architecture = null)
            {
                var device = new Dictionary<string, string>(StringComparer.Ordinal);
                AddOptional(device, "family", TelemetryContextValue.OptionalString(family, "device family"));
                AddOptional(device, "model", TelemetryContextValue.OptionalString(model, "device model"));
                AddOptional(device, "architecture", TelemetryContextValue.OptionalString(architecture, "device architecture"));
                RequireNonEmptySection(device, "device");
                sections["device"] = device;
                return this;
            }

            /// <summary>Sets application name, version, and build identity.</summary>
            public Builder WithApplication(string? name = null, string? version = null, string? build = null)
            {
                var application = new Dictionary<string, string>(StringComparer.Ordinal);
                AddOptional(application, "name", TelemetryContextValue.OptionalString(name, "application name"));
                AddOptional(application, "version", TelemetryContextValue.OptionalString(version, "application version"));
                AddOptional(application, "build", TelemetryContextValue.OptionalString(build, "application build"));
                RequireNonEmptySection(application, "application");
                sections["application"] = application;
                return this;
            }

            /// <summary>Builds one non-empty immutable resource.</summary>
            public TelemetryResource Build()
            {
                if (sections.Count == 0)
                {
                    throw TelemetryContextValue.Invalid("telemetry resource must not be empty");
                }

                return new TelemetryResource(sections);
            }

            private static Dictionary<string, string> NamedVersion(string name, string? version, string label)
            {
                var section = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["name"] = TelemetryContextValue.RequiredString(name, label + " name")
                };
                AddOptional(section, "version", TelemetryContextValue.OptionalString(version, label + " version"));
                return section;
            }

            private static void AddOptional(Dictionary<string, string> target, string key, string? value)
            {
                if (value != null)
                {
                    target[key] = value;
                }
            }

            private static void RequireNonEmptySection(Dictionary<string, string> section, string label)
            {
                if (section.Count == 0)
                {
                    throw TelemetryContextValue.Invalid(label + " must not be empty");
                }
            }
        }
    }
}

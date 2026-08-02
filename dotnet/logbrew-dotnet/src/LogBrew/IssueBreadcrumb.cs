using System.Collections.Generic;

namespace LogBrew
{
    /// <summary>
    /// One bounded oldest-to-newest step that happened before an issue.
    /// </summary>
    public sealed class IssueBreadcrumb
    {
        private IssueBreadcrumb(string timestamp, string category)
        {
            Timestamp = timestamp;
            Category = category;
        }

        /// <summary>
        /// Gets the RFC 3339 timestamp.
        /// </summary>
        public string Timestamp { get; }

        /// <summary>
        /// Gets the stable breadcrumb category.
        /// </summary>
        public string Category { get; }

        /// <summary>
        /// Gets the optional breadcrumb type.
        /// </summary>
        public string? Type { get; private set; }

        /// <summary>
        /// Gets the optional normalized breadcrumb severity.
        /// </summary>
        public string? Level { get; private set; }

        /// <summary>
        /// Gets the optional bounded message.
        /// </summary>
        public string? Message { get; private set; }

        /// <summary>
        /// Gets the optional flat finite primitive data fields.
        /// </summary>
        public IDictionary<string, object?>? Data { get; private set; }

        /// <summary>
        /// Creates a breadcrumb with an RFC 3339 timestamp and stable category.
        /// </summary>
        public static IssueBreadcrumb Create(string timestamp, string category)
        {
            return new IssueBreadcrumb(timestamp, category);
        }

        /// <summary>
        /// Sets the optional stable breadcrumb type.
        /// </summary>
        public IssueBreadcrumb WithType(string type)
        {
            Type = type;
            return this;
        }

        /// <summary>
        /// Sets the optional breadcrumb severity.
        /// </summary>
        public IssueBreadcrumb WithLevel(string level)
        {
            Level = level;
            return this;
        }

        /// <summary>
        /// Sets the optional bounded breadcrumb message.
        /// </summary>
        public IssueBreadcrumb WithMessage(string message)
        {
            Message = message;
            return this;
        }

        /// <summary>
        /// Sets up to eight flat finite primitive data fields.
        /// </summary>
        public IssueBreadcrumb WithData(IDictionary<string, object?> data)
        {
            Data = IssueDiagnostics.CopyBreadcrumbData(data);
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            IssueDiagnostics.RequireBreadcrumbTimestamp(Timestamp);
            var value = new OrderedJsonObject()
                .Add("timestamp", Timestamp)
                .Add("category", IssueDiagnostics.RequireBreadcrumbName("issue breadcrumb category", Category, true));
            if (Type != null)
            {
                value.Add("type", IssueDiagnostics.RequireBreadcrumbName("issue breadcrumb type", Type, true));
            }

            if (Level != null)
            {
                value.Add("level", IssueDiagnostics.NormalizeBreadcrumbLevel(Level));
            }

            if (Message != null)
            {
                value.Add("message", IssueDiagnostics.RequireBreadcrumbMessage(Message));
            }

            if (Data != null)
            {
                value.Add("data", IssueDiagnostics.BreadcrumbDataToJson(Data));
            }

            return value;
        }
    }
}

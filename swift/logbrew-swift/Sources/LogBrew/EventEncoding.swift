struct SDKInfo: Codable, Equatable {
    let name: String
    let language: String
    let version: String
}

struct EventBatch: Encodable {
    let sdk: SDKInfo
    let events: [Event]
}

struct Event: Codable, Equatable {
    let type: String
    let timestamp: String
    let id: String
    let attributes: EventAttributes

    private enum CodingKeys: String, CodingKey {
        case type
        case timestamp
        case id
        case attributes
    }

    init(type: String, timestamp: String, id: String, attributes: EventAttributes) {
        self.type = type
        self.timestamp = timestamp
        self.id = id
        self.attributes = attributes
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(id, forKey: .id)
        switch attributes {
        case let .release(value):
            try container.encode(value, forKey: .attributes)
        case let .environment(value):
            try container.encode(value, forKey: .attributes)
        case let .issue(value):
            try container.encode(value, forKey: .attributes)
        case let .log(value):
            try container.encode(value, forKey: .attributes)
        case let .span(value):
            try container.encode(value, forKey: .attributes)
        case let .action(value):
            try container.encode(value, forKey: .attributes)
        case let .metric(value):
            try container.encode(value, forKey: .attributes)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        id = try container.decode(String.self, forKey: .id)
        switch type {
        case "release":
            attributes = try .release(container.decode(ReleaseAttributes.self, forKey: .attributes))
        case "environment":
            attributes = try .environment(container.decode(EnvironmentAttributes.self, forKey: .attributes))
        case "issue":
            attributes = try .issue(container.decode(IssueAttributes.self, forKey: .attributes))
        case "log":
            attributes = try .log(container.decode(LogAttributes.self, forKey: .attributes))
        case "span":
            attributes = try .span(container.decode(SpanAttributes.self, forKey: .attributes))
        case "action":
            attributes = try .action(container.decode(ActionAttributes.self, forKey: .attributes))
        case "metric":
            attributes = try .metric(container.decode(MetricAttributes.self, forKey: .attributes))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unsupported event type",
            )
        }
    }
}

enum EventAttributes: Equatable {
    case release(ReleaseAttributes)
    case environment(EnvironmentAttributes)
    case issue(IssueAttributes)
    case log(LogAttributes)
    case span(SpanAttributes)
    case action(ActionAttributes)
    case metric(MetricAttributes)

    var eventType: String {
        switch self {
        case .release:
            "release"
        case .environment:
            "environment"
        case .issue:
            "issue"
        case .log:
            "log"
        case .span:
            "span"
        case .action:
            "action"
        case .metric:
            "metric"
        }
    }
}

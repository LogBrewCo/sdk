struct SDKInfo: Codable, Equatable {
    let name: String
    let language: String
    let version: String
}

struct EventBatch: Encodable {
    let sdk: SDKInfo
    let events: [Event]
}

struct Event: Encodable, Equatable {
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
        }
    }
}

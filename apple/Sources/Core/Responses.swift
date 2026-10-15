import Foundation

public enum Responses {
    public static func request(_ request: JSON, model: String) throws -> JSON {
        guard let history = request["history"] as? [JSON], history.count <= 2000,
              let prompt = request["systemPrompt"] as? String,
              JSONSerialization.isValidJSONObject(request), try JSONSerialization.data(withJSONObject: request).count <= 4_000_000 else { throw PlanError("invalid_request") }
        var input: [JSON] = []
        func string(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), as: UTF8.self) }
        for message in history {
            if message["role"] as? String == "model", let items = message["chatgptItems"] as? [JSON] {
                guard items.allSatisfy({ ["reasoning", "function_call", "message"].contains($0["type"] as? String ?? "") }) else { throw PlanError("invalid_request") }
                input += items
                continue
            }
            for part in message["parts"] as? [JSON] ?? [] {
                if let text = part["text"] as? String { input.append(["role": message["role"] as? String == "model" ? "assistant" : "user", "content": text]) }
                else if let call = part["functionCall"] as? JSON, let id = call["id"] as? String, let name = call["name"] as? String { input.append(["type": "function_call", "call_id": id, "name": name, "arguments": try string(call["args"] ?? JSON())]) }
                else if let response = part["functionResponse"] as? JSON, let id = response["id"] as? String { input.append(["type": "function_call_output", "call_id": id, "output": try string(response["response"] ?? NSNull())]) }
                else { throw PlanError("invalid_request") }
            }
        }
        let required = request["requireOutputTool"] as? Bool == true
        let tool = request["tool"] as? JSON
        let declarations = (tool.map { [$0] } ?? []) + (required ? [] : request["lookupTools"] as? [JSON] ?? [])
        let tools = try declarations.map { declaration -> JSON in
            guard let name = declaration["name"] as? String, name.range(of: "^[a-zA-Z0-9_-]{1,64}$", options: .regularExpression) != nil, let schema = declaration["schema"] as? JSON else { throw PlanError("invalid_request") }
            return ["type": "function", "name": name, "description": declaration["description"] as? String ?? "", "parameters": schema, "strict": false]
        }
        var body: JSON = ["model": model, "instructions": prompt, "input": input, "store": false, "stream": true, "include": ["reasoning.encrypted_content"]]
        if !tools.isEmpty {
            body["tools"] = tools
            body["tool_choice"] = required && tool != nil ? ["type": "function", "name": tool!["name"]!] : "required"
            body["parallel_tool_calls"] = !required
        }
        return body
    }
    public static func result(_ response: JSON, outputTool: String?) throws -> JSON {
        guard response["status"] as? String == "completed", let output = response["output"] as? [JSON] else { throw PlanError("incomplete") }
        var raw = "", toolInput: Any = NSNull(), lookups: [JSON] = []
        for item in output {
            if item["type"] as? String == "message" {
                for part in item["content"] as? [JSON] ?? [] where part["type"] as? String == "output_text" { raw += part["text"] as? String ?? "" }
            }
            if item["type"] as? String == "function_call" {
                guard let text = item["arguments"] as? String, let args = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed), let name = item["name"] as? String, let id = item["call_id"] as? String else { throw PlanError("incomplete") }
                if name == outputTool { toolInput = args } else { lookups.append(["id": id, "name": name, "args": args]) }
            }
        }
        if !lookups.isEmpty && output.contains(where: { $0["type"] as? String == "reasoning" }) {
            lookups[0]["chatgptItems"] = output.filter { ["reasoning", "message", "function_call"].contains($0["type"] as? String ?? "") }
        }
        guard !raw.isEmpty || !(toolInput is NSNull) || !lookups.isEmpty else { throw PlanError("incomplete") }
        var value: JSON = ["rawText": raw, "toolInput": toolInput]
        if !lookups.isEmpty { value["lookupCalls"] = lookups }
        return value
    }
}

/// Bounded byte parser: handles arbitrary UTF-8/network splits, CRLF and multiline data.
public struct EventStream {
    private var buffer = Data()
    private var lines: [String] = []
    private var eventBytes = 0
    private var total = 0
    public private(set) var completed: JSON?
    public init() {}
    public mutating func feed(_ data: Data) throws -> [JSON] {
        total += data.count
        guard total <= 32_000_000 else { throw PlanError("incomplete") }
        buffer.append(data)
        var events: [JSON] = []
        while let end = buffer.firstIndex(of: 10) {
            var bytes = buffer[..<end]
            if bytes.last == 13 { bytes = bytes.dropLast() }
            guard let line = String(data: bytes, encoding: .utf8) else { throw PlanError("incomplete") }
            buffer.removeSubrange(...end)
            eventBytes += bytes.count
            guard eventBytes <= 8_000_000 else { throw PlanError("incomplete") }
            if line.isEmpty {
                defer { lines.removeAll(keepingCapacity: true); eventBytes = 0 }
                guard !lines.isEmpty else { continue }
                let text = lines.joined(separator: "\n")
                if text == "[DONE]" { continue }
                guard let event = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? JSON else { throw PlanError("incomplete") }
                switch event["type"] as? String {
                case "response.failed", "error": throw PlanError.response(event["response"] as? JSON ?? event, status: 0)
                case "response.incomplete": throw PlanError("incomplete")
                case "response.completed":
                    guard completed == nil, let response = event["response"] as? JSON, response["status"] as? String == "completed" else { throw PlanError("incomplete") }
                    completed = response
                default: break
                }
                events.append(event)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst(5))
                lines.append(value.hasPrefix(" ") ? String(value.dropFirst()) : value)
            }
        }
        guard buffer.count <= 8_000_000 else { throw PlanError("incomplete") }
        return events
    }
    public func finish() throws -> JSON {
        guard let completed else { throw PlanError("incomplete") }
        return completed
    }
}

#if canImport(Security)
import Foundation
import Security

/// Dünne Schicht über `SecItem…`, damit Tests die Abfragen prüfen können, ohne die echte
/// Keychain anzufassen (ohne Signieren fehlt im Simulator die Zugriffsgruppe).
public protocol KeychainBackend: Sendable {
    func add(_ query: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?)
    func delete(_ query: [String: Any]) -> OSStatus
}

public struct SystemKeychain: KeychainBackend {
    public init() {}

    public func add(_ query: [String: Any]) -> OSStatus {
        SecItemAdd(query as CFDictionary, nil)
    }

    public func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    public func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }

    public func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public let status: OSStatus

    public var errorDescription: String? {
        "Keychain-Fehler \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unbekannt")"
    }
}

/// Der Geräte-Token (`vct_…`) in der Keychain-Gruppe, die App und Share Extension teilen.
///
/// ```swift
/// let config = AppConfiguration()
/// let token = try KeychainStore(accessGroup: config.keychainGroup).token()
/// ```
public struct KeychainStore: Sendable {
    static let service = "dev.rubeen.cockpit"
    static let account = "device-token"

    private let accessGroup: String
    private let backend: any KeychainBackend

    /// `accessGroup` wie in `AppConfiguration.keychainGroup` (mit Team-Präfix).
    public init(accessGroup: String, backend: any KeychainBackend = SystemKeychain()) {
        self.accessGroup = accessGroup
        self.backend = backend
    }

    private var query: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
        if !accessGroup.isEmpty { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    /// Der gespeicherte Token, `nil` ohne Anmeldung.
    public func token() throws -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = backend.copyMatching(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    /// Legt den Token an oder ersetzt ihn. Lesbar nach dem ersten Entsperren (Share Extension,
    /// Player im Hintergrund), nur auf diesem Gerät, nicht im Backup.
    public func save(token: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = backend.add(query.merging(attributes) { $1 })
        if status == errSecDuplicateItem { status = backend.update(query, attributes) }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func deleteToken() throws {
        let status = backend.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
#endif

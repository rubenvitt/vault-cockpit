import CockpitShared
import Security
import XCTest

/// Keychain im Speicher mit denselben Statuscodes wie `SecItem…`; merkt sich die Abfragen.
final class MockKeychain: KeychainBackend, @unchecked Sendable {
    var items: [String: Data] = [:]
    var queries: [[String: Any]] = []
    var failWith: OSStatus?

    private func key(_ query: [String: Any]) -> String {
        "\(query[kSecAttrAccessGroup as String] ?? "-")|\(query[kSecAttrService as String] ?? "")|\(query[kSecAttrAccount as String] ?? "")"
    }

    func add(_ query: [String: Any]) -> OSStatus {
        queries.append(query)
        if let failWith { return failWith }
        if items[key(query)] != nil { return errSecDuplicateItem }
        items[key(query)] = query[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        queries.append(query)
        guard items[key(query)] != nil else { return errSecItemNotFound }
        items[key(query)] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        queries.append(query)
        if let failWith { return (failWith, nil) }
        guard let data = items[key(query)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        queries.append(query)
        return items.removeValue(forKey: key(query)) == nil ? errSecItemNotFound : errSecSuccess
    }
}

final class KeychainStoreTests: XCTestCase {
    func testSaveReadReplaceDelete() throws {
        let keychain = MockKeychain()
        let store = KeychainStore(accessGroup: "TEAM.dev.rubeen.cockpit.shared", backend: keychain)
        XCTAssertNil(try store.token())

        try store.save(token: "vct_eins")
        XCTAssertEqual(try store.token(), "vct_eins")
        // Zweites Speichern ersetzt (errSecDuplicateItem → Update).
        try store.save(token: "vct_zwei")
        XCTAssertEqual(try store.token(), "vct_zwei")
        XCTAssertEqual(keychain.items.count, 1)

        try store.deleteToken()
        XCTAssertNil(try store.token())
        XCTAssertNoThrow(try store.deleteToken(), "Löschen ohne Eintrag ist kein Fehler")
    }

    func testQueriesUseSharedGroupAndDeviceOnlyAccess() throws {
        let keychain = MockKeychain()
        try KeychainStore(accessGroup: "TEAM.dev.rubeen.cockpit.shared", backend: keychain).save(token: "vct_x")
        let add = try XCTUnwrap(keychain.queries.first)
        XCTAssertEqual(add[kSecAttrAccessGroup as String] as? String, "TEAM.dev.rubeen.cockpit.shared")
        XCTAssertEqual(add[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(add[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(add[kSecValueData as String] as? Data, Data("vct_x".utf8))
    }

    func testErrorsAreThrown() {
        let keychain = MockKeychain()
        keychain.failWith = errSecMissingEntitlement
        let store = KeychainStore(accessGroup: "x", backend: keychain)
        XCTAssertThrowsError(try store.token()) { XCTAssertEqual(($0 as? KeychainError)?.status, errSecMissingEntitlement) }
        XCTAssertThrowsError(try store.save(token: "vct_x"))
    }
}

import Foundation
import XCTest
@testable import CockpitShared

final class MacUpdateTests: XCTestCase {
    func testAppVersionParsesAndCompares() throws {
        XCTAssertEqual(AppVersion("1.0"), AppVersion(major: 1, minor: 0, patch: 0))
        XCTAssertEqual(AppVersion("1.10.2")?.description, "1.10.2")
        XCTAssertNil(AppVersion("1"))
        XCTAssertNil(AppVersion("1.2.3.4"))
        XCTAssertNil(AppVersion("1.x.0"))
        XCTAssertNil(AppVersion("1..0"))
        XCTAssertNil(AppVersion("-1.0.0"))
        XCTAssertLessThan(try XCTUnwrap(AppVersion("1.9.0")), try XCTUnwrap(AppVersion("1.10.0")))
        XCTAssertLessThan(try XCTUnwrap(AppVersion("1.0")), try XCTUnwrap(AppVersion("1.0.1")))
    }

    func testUpdateFromRollingRelease() throws {
        let update = try XCTUnwrap(try MacUpdateFeed.update(in: Self.release(), newerThan: try XCTUnwrap(AppVersion("1.1.0"))))
        XCTAssertEqual(update.version.description, "1.3.0")
        XCTAssertEqual(update.archiveURL.absoluteString, "https://github.com/rubenvitt/vault-cockpit/releases/download/macos-0.0.0/Cockpit-mac-1.3.0.zip")
        XCTAssertEqual(update.diskImageURL?.lastPathComponent, "Cockpit.dmg")
        XCTAssertEqual(update.pageURL.absoluteString, "https://github.com/rubenvitt/vault-cockpit/releases/tag/macos-0.0.0")
        XCTAssertEqual(update.archiveSize, 12_345)
        XCTAssertEqual(update.archiveSHA256, String(repeating: "ab", count: 32))
        XCTAssertTrue(update.notes.hasPrefix("### Neu"))
    }

    func testNoUpdate() throws {
        let old = try XCTUnwrap(AppVersion("1.0"))
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(), newerThan: try XCTUnwrap(AppVersion("1.3.0"))), "gleiche Version")
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(tag: "0.1.0"), newerThan: old), "anderer Tag")
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(title: "Cockpit für macOS"), newerThan: old), "ohne Version")
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(draft: true), newerThan: old), "Entwurf")
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(archive: "Cockpit.zip"), newerThan: old), "ohne Archiv")
        // Titel noch alt, das neue Archiv schon da (Lauf zwischen Upload und Titel abgebrochen): das
        // Archiv zum Titel zählt, nicht ein neueres.
        XCTAssertNil(try MacUpdateFeed.update(in: Self.release(archive: "Cockpit-mac-1.4.0.zip"), newerThan: old), "Archiv passt nicht zum Titel")
    }

    func testVersionFromTitle() {
        XCTAssertEqual(MacUpdateFeed.version(fromTitle: "Cockpit für macOS 1.3.0")?.description, "1.3.0")
        XCTAssertEqual(MacUpdateFeed.version(fromTitle: "Cockpit für macOS 1.3.0 (Hotfix)")?.description, "1.3.0")
        XCTAssertNil(MacUpdateFeed.version(fromTitle: "Cockpit für macOS"))
        XCTAssertNil(MacUpdateFeed.version(fromTitle: nil))
    }

    func testReleaseURL() {
        XCTAssertEqual(MacUpdateFeed.releaseURL.absoluteString, "https://api.github.com/repos/rubenvitt/vault-cockpit/releases/tags/macos-0.0.0")
    }

    func testDigestOnlySha256() {
        XCTAssertNil(MacUpdateFeed.sha256(nil))
        XCTAssertNil(MacUpdateFeed.sha256("sha512:abcd"))
        XCTAssertNil(MacUpdateFeed.sha256("sha256:zz"))
        XCTAssertEqual(MacUpdateFeed.sha256("sha256:" + String(repeating: "AB", count: 32)), String(repeating: "ab", count: 32))
    }

    func testDisplayNotesDropsInstallHint() {
        let notes = "### Neu\n\n- Updates in der App\n\n### Behoben\n\n- Login\n\n---\n\n**Installieren:** …\n"
        XCTAssertEqual(MacUpdateFeed.displayNotes(notes), "Neu:\n\n- Updates in der App\n\nBehoben:\n\n- Login")
    }

    /// Antwort von `GET /repos/…/releases/tags/macos-0.0.0`, gekürzt; das echte Release ist eine Vorabversion.
    static func release(tag: String = "macos-0.0.0", title: String = "Cockpit für macOS 1.3.0", draft: Bool = false,
                        archive: String = "Cockpit-mac-1.3.0.zip") -> Data {
        let digest = String(repeating: "ab", count: 32)
        return Data("""
        {"tag_name": "\(tag)", "name": "\(title)", "body": "### Neu\\n\\n- Updates", "draft": \(draft), "prerelease": true,
         "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/macos-0.0.0",
         "assets": [
           {"name": "Cockpit.dmg", "size": 99999,
            "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/macos-0.0.0/Cockpit.dmg"},
           {"name": "\(archive)", "size": 12345, "digest": "sha256:\(digest)",
            "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/macos-0.0.0/\(archive)"}
         ]}
        """.utf8)
    }
}

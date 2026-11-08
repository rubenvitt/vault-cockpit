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

    func testNewestPicksHighestMacReleaseWithArchive() throws {
        let current = try XCTUnwrap(AppVersion("1.1.0"))
        let update = try XCTUnwrap(try MacUpdateFeed.newest(in: Self.releases, newerThan: current))
        XCTAssertEqual(update.version.description, "1.3.0")
        XCTAssertEqual(update.archiveURL.absoluteString, "https://github.com/rubenvitt/vault-cockpit/releases/download/mac/v1.3.0/Cockpit-mac.zip")
        XCTAssertEqual(update.diskImageURL?.lastPathComponent, "Cockpit-1.3.0.dmg")
        XCTAssertEqual(update.pageURL.absoluteString, "https://github.com/rubenvitt/vault-cockpit/releases/tag/mac/v1.3.0")
        XCTAssertEqual(update.archiveSize, 12_345)
        XCTAssertEqual(update.archiveSHA256, String(repeating: "ab", count: 32))
        XCTAssertTrue(update.notes.hasPrefix("### Neu"))
    }

    func testNoUpdateWhenCurrentIsNewest() throws {
        XCTAssertNil(try MacUpdateFeed.newest(in: Self.releases, newerThan: try XCTUnwrap(AppVersion("1.3.0"))))
        XCTAssertNil(try MacUpdateFeed.newest(in: Data("[]".utf8), newerThan: try XCTUnwrap(AppVersion("1.0"))))
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

    /// Antwort von `GET /repos/…/releases`, gekürzt: Plugin-Release, Entwurf, Vorabversion, eines ohne
    /// Archiv und zwei echte Mac-Releases.
    static let releases = Data("""
    [
      {"tag_name": "mac/v1.4.0", "name": "Entwurf", "body": "", "draft": true, "prerelease": false,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/untagged-1",
       "assets": [{"name": "Cockpit-mac.zip", "size": 1, "digest": null,
                   "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/untagged-1/Cockpit-mac.zip"}]},
      {"tag_name": "mac/v1.3.1", "name": "Vorab", "body": "", "draft": false, "prerelease": true,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/mac/v1.3.1",
       "assets": [{"name": "Cockpit-mac.zip", "size": 1,
                   "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/mac/v1.3.1/Cockpit-mac.zip"}]},
      {"tag_name": "9.9.9", "name": "Plugin", "body": "", "draft": false, "prerelease": false,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/9.9.9",
       "assets": [{"name": "main.js", "size": 1,
                   "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/9.9.9/main.js"}]},
      {"tag_name": "mac/v1.5.0", "name": "Ohne Archiv", "body": "", "draft": false, "prerelease": false,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/mac/v1.5.0", "assets": []},
      {"tag_name": "mac/v1.2.0", "name": "Cockpit für macOS 1.2.0", "body": "### Behoben", "draft": false, "prerelease": false,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/mac/v1.2.0",
       "assets": [{"name": "Cockpit-mac.zip", "size": 1,
                   "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/mac/v1.2.0/Cockpit-mac.zip"}]},
      {"tag_name": "mac/v1.3.0", "name": "Cockpit für macOS 1.3.0", "body": "### Neu\\n\\n- Updates", "draft": false, "prerelease": false,
       "html_url": "https://github.com/rubenvitt/vault-cockpit/releases/tag/mac/v1.3.0",
       "assets": [
         {"name": "Cockpit-1.3.0.dmg", "size": 99999,
          "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/mac/v1.3.0/Cockpit-1.3.0.dmg"},
         {"name": "Cockpit-mac.zip", "size": 12345, "digest": "sha256:\(String(repeating: "ab", count: 32))",
          "browser_download_url": "https://github.com/rubenvitt/vault-cockpit/releases/download/mac/v1.3.0/Cockpit-mac.zip"}
       ]}
    ]
    """.utf8)
}

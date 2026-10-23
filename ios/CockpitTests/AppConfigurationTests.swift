import CockpitShared
import XCTest

final class AppConfigurationTests: XCTestCase {
    func testReadsServerURLFromInfo() {
        let config = AppConfiguration(info: ["CockpitServerURL": "https://vault.example.org"])
        XCTAssertEqual(config.serverURL, URL(string: "https://vault.example.org"))
    }

    func testAppBundleCarriesServerURL() {
        // Prüft, dass COCKPIT_SERVER_URL vollständig in der Info.plist der App landet.
        let url = AppConfiguration().serverURL
        XCTAssertNotNil(url.host)
        XCTAssertTrue(["https", "http"].contains(url.scheme))
    }
}

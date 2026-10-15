import XCTest
final class GameUITests: XCTestCase {
    func testLocalGameBootsWithNativeControls() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["Keep saves"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        let explore = app.webViews.buttons["Explore first"]
        if explore.waitForExistence(timeout: 10) { explore.tap() }
        XCTAssertTrue(app.webViews.buttons["Scenarios"].waitForExistence(timeout: 40))
        XCTAssertFalse(app.staticTexts["The local game could not start. Close Open Historia and try again. No saved data was changed."].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.lifetime = .keepAlways; add(screenshot)
        app.terminate(); app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.webViews.buttons["Scenarios"].waitForExistence(timeout: 40))
    }
}

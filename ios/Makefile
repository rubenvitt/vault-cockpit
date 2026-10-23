# Bauen und Testen ohne Xcode-Oberfläche. Simulator-Builds laufen ohne Signieren.
PROJECT := Cockpit.xcodeproj
SCHEME := Cockpit
BUILD_NUMBER ?= 1
# Erstes verfügbare iPhone laut simctl (auf CI-Runnern verlässlicher als -showdestinations);
# per DESTINATION=… überschreibbar.
SIMULATOR_ID = $(shell xcrun simctl list devices available | grep -E '^ +iPhone' | head -1 | grep -oE '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}')
DESTINATION ?= platform=iOS Simulator,id=$(SIMULATOR_ID)

XCODEBUILD = xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination '$(DESTINATION)' \
	-derivedDataPath build CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION=$(BUILD_NUMBER)

.PHONY: project build test clean

project:
	xcodegen generate

build: project
	$(XCODEBUILD) build

test: project
	$(XCODEBUILD) test

clean:
	rm -rf build $(PROJECT)

# Bauen und Testen ohne Xcode-Oberfläche. Simulator-Builds laufen ohne Signieren.
PROJECT := Cockpit.xcodeproj
SCHEME := Cockpit
BUILD_NUMBER ?= 1
# Erstes iPhone, das xcodebuild für dieses Schema als Simulator anbietet; per DESTINATION=… überschreibbar.
DESTINATION ?= platform=iOS Simulator,id=$(shell xcodebuild -project $(PROJECT) -scheme $(SCHEME) -showdestinations 2>/dev/null | grep -m1 'platform:iOS Simulator.*name:iPhone' | grep -oE 'id:[0-9A-Fa-f-]+' | cut -d: -f2)

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

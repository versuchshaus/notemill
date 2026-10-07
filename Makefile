# Notemill build.
# Copyright (c) 2026 Stephan von Lingelsheim. See LICENCE.

EXTNAME := notemill
BUILD   := build

# The version is read from the *committed* manifest: manifest.json is
# generated, and make expands this while parsing, when it may not exist yet.
# An empty VERSION silently yields "notemill-.zip" - that bug has been shipped
# here twice, once from a python2 call and once from this very rule.
VERSION := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.base.json)

# Your own build: it packs your local notion-config.js, which may hold your
# client secret, so it gets a name that cannot be mistaken for the release.
ZIP     := $(EXTNAME)-$(VERSION)-local.zip
STOREZIP:= $(EXTNAME)-$(VERSION)-store.zip
RELZIP  := $(EXTNAME)-$(VERSION).zip

# What ships. Everything else in the tree is source, key material or notes:
#   manifest.base.json  the template manifest.json is generated from
#   notemill-*.zip      previous builds
#   tools/              build scripts
#   server/             the token exchange, deployed separately
#   build/              staging
SHIPPED := manifest.json readability.js content.js sw.js notion.js folder.js \
           notion-config.js notion-config.example.js options.html options.js \
           pick.html pick.js ui-theme.js \
           css img LICENCE NOTICE LICENCE-APACHE FONT-LICENCE.txt README.md PRIVACY.md

all: $(ZIP)

# manifest.json is generated: git holds manifest.base.json, and the pinned
# extension id comes from a key kept outside the repository. See tools/manifest.py.
manifest.json: manifest.base.json tools/manifest.py
	@tools/manifest.py

manifest: manifest.json

icons:
	@tools/icons.py

# One staging step, shared by both archives. $(1) is the manifest to install.
define stage
	rm -rf $(BUILD)/$(EXTNAME)
	mkdir -p $(BUILD)/$(EXTNAME)
	for item in $(filter-out manifest.json, $(SHIPPED)); do \
	  test -e "$$item" && cp -R "$$item" $(BUILD)/$(EXTNAME)/ || true; \
	done
	cp $(1) $(BUILD)/$(EXTNAME)/manifest.json
endef

# Existing CSS/image edits do not change their directory's mtime.
ASSETS := $(shell find css img -type f)

$(ZIP): manifest.json $(SHIPPED) $(ASSETS)
	$(call stage,manifest.json)
	cd $(BUILD)/$(EXTNAME) && zip -q -r ../../$(ZIP) .
	@echo "$(ZIP) built"

zip: $(ZIP)

# A build for the Chrome Web Store: no pinned key, because the store assigns
# the id, and no notion-config.js, because a published extension cannot carry
# an OAuth client secret.
# Firefox build: an event page instead of a service worker, and no pinned key
# (Firefox identifies the extension by its Gecko id).
firefox: $(SHIPPED)
	@mkdir -p $(BUILD)
	@tools/manifest.py --target firefox --out $(BUILD)/manifest.firefox.json
	$(call stage,$(BUILD)/manifest.firefox.json)
	@tools/appconfig.py --strip-secret --out $(BUILD)/$(EXTNAME)/notion-config.js
	cd $(BUILD)/$(EXTNAME) && zip -q -r ../../$(EXTNAME)-$(VERSION)-firefox.zip .
	@echo "$(EXTNAME)-$(VERSION)-firefox.zip built"

store: $(SHIPPED)
	@mkdir -p $(BUILD)
	@tools/manifest.py --target chrome --no-key --out $(BUILD)/manifest.store.json
	$(call stage,$(BUILD)/manifest.store.json)
	@tools/appconfig.py --strip-secret --out $(BUILD)/$(EXTNAME)/notion-config.js
	cd $(BUILD)/$(EXTNAME) && zip -q -r ../../$(STOREZIP) .
	@echo "$(STOREZIP) built: no key, no notion-config.js"

# The download for people who install by hand ("Load unpacked"), and the one
# attached to a GitHub release. It keeps the pinned id, so every install gets
# the same extension id and the redirect URI registered at Notion matches on
# every machine; it keeps the public client id and exchange URL, so Connect
# works; and it carries no client secret. The archive holds one folder,
# notemill/, which is what people select in Chrome after unzipping.
release: $(SHIPPED) $(ASSETS)
	@mkdir -p $(BUILD)
	@tools/manifest.py --target chrome --out $(BUILD)/manifest.release.json
	$(call stage,$(BUILD)/manifest.release.json)
	@tools/appconfig.py --strip-secret --out $(BUILD)/$(EXTNAME)/notion-config.js
	@grep -q '"key"' $(BUILD)/$(EXTNAME)/manifest.json || \
	  { echo "release: no pinned key - the Notion redirect URI would differ per install"; exit 1; }
	rm -f $(RELZIP)
	cd $(BUILD) && zip -q -r -X ../$(RELZIP) $(EXTNAME) -x '*.DS_Store'
	cp $(RELZIP) $(EXTNAME).zip
	@echo "$(RELZIP) built, and copied to $(EXTNAME).zip for the release (the README links to that name)."
	@echo "Pinned id, public Notion config, no secret."

clean:
	rm -rf $(BUILD) $(EXTNAME)-*.zip $(EXTNAME).zip

.PHONY: all zip store firefox release manifest icons clean

// Optional. Copy to notion-config.js and fill in, and the extension stops
// asking anyone to create a Notion integration: the options page then shows a
// single "Connect to Notion" button that opens Notion's own consent window.
//
// Where the values come from: notion.so/profile/integrations -> your
// integration -> Configuration. The redirect URI to register there is shown on
// the options page.
//
// WHY THIS FILE IS NOT IN GIT
// Notion's token exchange requires the client secret (they support no PKCE, so
// there is no secretless public-client flow). A secret inside a distributed
// extension is extractable by anyone who has the extension, so this file is
// gitignored and must not be shared. `make` DOES pack it into the zip, which
// is fine for your own install and not fine for publishing.
var LR_NOTION_APP = {
  clientId:     "",
  // Leave the secret empty and set exchangeUrl for anything you distribute: a
  // secret inside an extension can be read by whoever installs it. See server/.
  clientSecret: "",
  exchangeUrl:  ""
};

if (typeof module !== "undefined" && module.exports) { module.exports = LR_NOTION_APP; }

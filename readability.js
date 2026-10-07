/*jslint undef: true, nomen: true, eqeqeq: true, plusplus: true, newcap: true, immed: true, browser: true, devel: true, passfail: false */
/*global window: false, readConvertLinksToFootnotes: false, readStyle: false, readSize: false, readMargin: false, Typekit: false, ActiveXObject: false */

var dbg = (typeof console !== 'undefined') ? function(s) {
  // console.log("Readability: " + s);
} : function() {};

/*
 * Readability. An Arc90 Lab Experiment.
 * Website: http://lab.arc90.com/experiments/readability
 * Source:  http://code.google.com/p/arc90labs-readability
 *
 * "Readability" is a trademark of Arc90 Inc and may not be used without explicit permission.
 *
 * Copyright (c) 2010 Arc90 Inc
 * Readability is licensed under the Apache License, Version 2.0.
 * A copy of that licence is distributed with this extension as LICENCE-APACHE.
 *
 * MODIFIED for Notemill (2026, Stephan von Lingelsheim). Apache 2.0 permits
 * this, provided the notices above are kept, the licence travels with the code
 * and the changes are stated - all of which this header and LICENCE-APACHE do.
 * Notemill itself is MIT licensed (LICENCE).
 *
 * Changes to this file, all after version 1.7.1:
 *   - chrome.extension.getURL -> chrome.runtime.getURL (Manifest V3)
 *   - cleanConditionally no longer deletes wrapper elements that hold a
 *     content-sized image (hasContentImage)
 *   - grabArticle promotes an <article> ancestor when the top candidate covers
 *     only a fraction of it, which fixes truncated Medium-style articles
 *   - added: full-resolution image upgrade, Markdown export, folder export,
 *     Notion block conversion, theme handling, and the tools bar
 *   - Astra: shared toolbar row/focus lifecycle, editable-key guards, and
 *     generation checks preventing stale asynchronous feedback
 *   - Astra: owner-aligned feedback with a full-width wrapped-toolbar fallback
 *   - Astra: explicit busy/error states and persistent actionable errors
 *   - Astra: Notion recovery links open the relevant settings section
**/
var readability = {
    version:                '1.7.1',
    iframeLoads:             0,
    convertLinksToFootnotes: false,
    reversePageScroll:       false, /* If they hold shift and hit space, scroll up */
    frameHack:               false, /**
                                      * The frame hack is to workaround a firefox bug where if you
                                      * pull content out of a frame and stick it into the parent element, the scrollbar won't appear.
                                      * So we fake a scrollbar in the wrapping div.
                                     **/
    biggestFrame:            false,
    bodyCache:               null,   /* Cache the body HTML in case we need to re-use it later */
    flags:                   0x1 | 0x2 | 0x4,   /* Start with all flags set. */

    /* constants */
    FLAG_STRIP_UNLIKELYS:     0x1,
    FLAG_WEIGHT_CLASSES:      0x2,
    FLAG_CLEAN_CONDITIONALLY: 0x4,

    /* A top candidate covering less than 1/this of its <article> ancestor's
       text means the body is split across sibling wrappers; promote the
       ancestor. Link density above the second value marks it as furniture. */
    SECTIONED_ARTICLE_MIN_GAIN:        1.3,
    SECTIONED_ARTICLE_MAX_LINK_DENSITY: 0.3,

    /* Below these rendered dimensions an image counts as page furniture
       (avatars, icons, thumbnail rails) rather than article content. */
    CONTENT_IMAGE_MIN_WIDTH:  200,
    CONTENT_IMAGE_MIN_HEIGHT: 100,

    maxPages:    30, /* The maximum number of pages to loop through before we call it quits and just show a link. */
    parsedPages: {}, /* The list of pages we've parsed in this call of readability, for autopaging. As a key store for easier searching. */
    pageETags:   {}, /* A list of the ETag headers of pages we've parsed, in case they happen to match, we'll know it's a duplicate. */

    /**
     * All of the regular expressions in use within readability.
     * Defined up here so we don't instantiate them repeatedly in loops.
     **/
    regexps: {
        unlikelyCandidates:    /combx|comment|community|disqus|extra|foot|header|menu|remark|rss|shoutbox|sidebar|sponsor|ad-break|agegate|pagination|pager|popup|tweet|twitter/i,
        okMaybeItsACandidate:  /and|article|body|column|main|shadow/i,
        positive:              /article|body|content|entry|hentry|main|page|pagination|post|text|blog|story/i,
        negative:              /combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|shoutbox|sidebar|sponsor|shopping|tags|tool|widget/i,
        extraneous:            /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single/i,
        divToPElements:        /<(a|blockquote|dl|div|img|ol|p|pre|table|ul)/i,
        replaceBrs:            /(<br[^>]*>[ \n\r\t]*){2,}/gi,
        replaceFonts:          /<(\/?)font[^>]*>/gi,
        trim:                  /^\s+|\s+$/g,
        normalize:             /\s{2,}/g,
        killBreaks:            /(<br\s*\/?>(\s|&nbsp;?)*){1,}/g,
        videos:                /http:\/\/(www\.)?(youtube|vimeo)\.com/i,
        skipFootnoteLink:      /^\s*(\[?[a-z0-9]{1,2}\]?|^|edit|citation needed)\s*$/i,
        nextLink:              /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i, // Match: next, continue, >, >>, » but not >|, »| as those usually mean last.
        prevLink:              /(prev|earl|old|new|<|«)/i
    },

    /**
     * Runs readability.
     *
     * Workflow:
     *  1. Prep the document by removing script tags, css, etc.
     *  2. Build readability's DOM tree.
     *  3. Grab the article content from the current dom tree.
     *  4. Replace the current DOM tree with the new one.
     *  5. Read peacefully.
     *
     * @return void
     **/
    init: function() {
        /* Before we do anything, remove all scripts that are not readability. */
        window.onload = window.onunload = function() {};

        readability.removeScripts(document);

        if(document.body && !readability.bodyCache) {
            readability.bodyCache = document.body.innerHTML;
        }
        /* Make sure this document is added to the list of parsed pages first, so we don't double up on the first page */
        readability.parsedPages[window.location.href.replace(/\/$/, '')] = true;

        /* Pull out any possible next page link first */
        var nextPageLink = readability.findNextPageLink(document.body);

        /* Must run before the document is reassembled: srcset is the browser's
           own candidate list and does not survive the rewrite. */
        readability.upgradeImages(document);

        readability.prepDocument();

        /* Build readability's DOM tree */
        var overlay        = document.createElement("DIV");
        var innerDiv       = document.createElement("DIV");
        var articleTools   = readability.getArticleTools();
        var articleTitle   = readability.getArticleTitle();
        var articleContent = readability.grabArticle();
        var articleFooter  = readability.getArticleFooter();

        if(!articleContent) {
            articleContent    = document.createElement("DIV");
            articleContent.id = "readability-content";
            articleContent.innerHTML = [
                "<p>Sorry, readability was unable to parse this page for content. If you feel like it should have been able to, please <a href='http://code.google.com/p/arc90labs-readability/issues/entry'>let us know by submitting an issue.</a></p>",
                (readability.frameHack ? "<p><strong>It appears this page uses frames.</strong> Unfortunately, browser security properties often cause Readability to fail on pages that include frames. You may want to try running readability itself on this source page: <a href='" + readability.biggestFrame.src + "'>" + readability.biggestFrame.src + "</a></p>" : ""),
                "<p>Also, please note that Readability does not play very nicely with front pages. Readability is intended to work on articles with a sizable chunk of text that you'd like to read comfortably. If you're using Readability on a landing page (like nytimes.com for example), please click into an article first before using Readability.</p>"
            ].join('');

            nextPageLink = null;
        }

        overlay.id              = "readOverlay";
        innerDiv.id             = "readInner";

      /* Apply user-selected styling */
      readStyle = 'temp-style';
      readMargin = 'temp-margin';
      readSize = 'temp-readSize';
        document.body.className = readStyle;
        document.dir            = readability.getSuggestedDirection(articleTitle.innerHTML);

        if (readStyle === "style-athelas" || readStyle === "style-apertura"){
            overlay.className = readStyle + " rdbTypekit";
        }
        else {
            overlay.className = readStyle;
        }
        innerDiv.className    = readMargin + " " + readSize;

        if(typeof(readConvertLinksToFootnotes) !== 'undefined' && readConvertLinksToFootnotes === true) {
            readability.convertLinksToFootnotes = true;
        }



      /* Glue the structure of our document together. */
      innerDiv.appendChild( articleTitle   );
        innerDiv.appendChild( articleContent );
        innerDiv.appendChild( articleFooter  );
         overlay.appendChild( articleTools   );
         overlay.appendChild( innerDiv       );

        /* Clear the old HTML, insert the new content. */
        document.body.innerHTML = "";
        document.body.insertBefore(overlay, document.body.firstChild);
      document.body.removeAttribute('style');

      /* Every button is bound here. window.print() and location.reload() are
         plain DOM calls and work perfectly well from the isolated world - the
         inline attributes they used to rely on were both unnecessary and
         fragile, since any page with a script-src policy blocked them. */
      (function () {
        var actions = {
          "copy-markdown": function () { readability.exportMarkdown("copy"); },
          "save-markdown": function () { readability.exportMarkdown("save"); },
          "send-notion":   function () { readability.sendToNotion(); },
          /* The print dialog supplies feedback without claiming another action's row. */
          "print-page":    function () {
            window.print();
          },
          "reload-page":   function () { window.location.reload(); },
          /* The options page is otherwise buried behind Details on the
             browser's own extensions page. */
          "open-settings": function () { readability.notionMessage({type: "open-options"}, function () {}); }
        };

        for (var id in actions) {
          (function (id, run) {
            var el = document.getElementById(id);
            if (!el) { return; }
            el.addEventListener("click", function (e) {
              e.preventDefault();
              run();
            });
          }(id, actions[id]));
        }

        /* Escape backs out, one layer at a time: an open suggestion menu first
           (its own handler calls preventDefault, which is why this checks),
           then whatever the bar is asking, and finally the reader itself -
           which means reloading the page the article came from. */
        document.addEventListener("keydown", function (e) {
          if (e.key !== "Escape" || e.defaultPrevented) { return; }
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) { return; }

          var status = document.getElementById("readMarkdownStatus");
          if (status && status.textContent.replace(/\s+/g, "") !== "") {
            readability.closeRow(true);
            e.preventDefault();
            return;
          }

          e.preventDefault();
          window.location.reload();
        });

        /* These look and behave like buttons, so Space must work too - an <a>
           only responds to Enter. Delegated, so the buttons the Notion flow
           inserts later are covered as well. Typing a space in the tag field
           must still type a space, hence the tag check. */
        /* Intent signal: warm the Notion data as soon as the pointer or focus
           arrives, so the click opens the chooser with nothing to wait for. */
        var trigger = document.getElementById("send-notion");
        if (trigger) {
          trigger.addEventListener("pointerenter", readability.notionPrefetch);
          trigger.addEventListener("focus", readability.notionPrefetch);
          /* Converting a page is itself a statement of intent, so the action
             most likely to follow is ready for Enter straight away. */
          readability.arm(trigger);
        }

        readability.initTheme();

        var bar = document.getElementById("readTools");
        if (bar) {
          /* Reflow on viewport, font and toolbar-size changes, not on scroll. */
          window.addEventListener("resize", readability.alignRow);
          if (typeof ResizeObserver !== "undefined") {
            readability.rowResizeObserver = new ResizeObserver(readability.alignRow);
            readability.rowResizeObserver.observe(bar.firstElementChild);
          }
          /* The bar is sticky; it only looks lifted once something is under it. */
          (function () {
            var base = bar.getBoundingClientRect().top + window.pageYOffset;
            var tick = false;
            function update() {
              tick = false;
              var stuck = window.pageYOffset > base - 4;
              if (stuck !== bar.classList.contains("stuck")) { bar.classList.toggle("stuck", stuck); }
            }
            window.addEventListener("scroll", function () {
              if (!tick) { tick = true; window.requestAnimationFrame(update); }
            }, {passive: true});
            update();
          }());
          bar.addEventListener("keydown", function (e) {
            if (e.key !== " " && e.key !== "Spacebar") { return; }
            if (!e.target || e.target.tagName !== "A") { return; }
            e.preventDefault();
            e.target.click();
          });
        }
      }());


      /* Add the css */
      chrome.storage.sync.get({
        cssReadability: '',
      }, function(items) {
        if (items.cssReadability) {
          // Apply custom style
          document.querySelector('head').innerHTML = '<style>' + items.cssReadability + '</style>';
        } else {
          // Apply default style
          var cssFile = chrome.runtime.getURL("css/readability.css");
          document.querySelector('head').innerHTML = '<link rel="stylesheet" type="text/css" href="' + cssFile + '" >';
        }
      });

      if(readability.frameHack)
        {
            var readOverlay = document.getElementById('readOverlay');
            readOverlay.style.height = '100%';
            readOverlay.style.overflow = 'auto';
        }

        /**
         * If someone tries to use Readability on a site's root page, give them a warning about usage.
        **/
        if((window.location.protocol + "//" + window.location.host + "/") === window.location.href)
        {
            articleContent.style.display = "none";
            var rootWarning = document.createElement('p');
                rootWarning.id = "readability-warning";
                rootWarning.innerHTML = "<em>Readability</em> was intended for use on individual articles and not home pages. " +
                    "If you'd like to try rendering this page anyway, <a onClick='javascript:document.getElementById(\"readability-warning\").style.display=\"none\";document.getElementById(\"readability-content\").style.display=\"block\";'>click here</a> to continue.";

            innerDiv.insertBefore( rootWarning, articleContent );
        }

        readability.postProcessContent(articleContent);

        window.scrollTo(0, 0);

        /* If we're using the Typekit library, select the font */
        if (readStyle === "style-athelas" || readStyle === "style-apertura") {
            readability.useRdbTypekit();
        }

        if (nextPageLink) {
            /**
             * Append any additional pages after a small timeout so that people
             * can start reading without having to wait for this to finish processing.
            **/
            window.setTimeout(function() {
                readability.appendNextPage(nextPageLink);
            }, 500);
        }

        /** Smooth scrolling **/
        document.onkeydown = function(e) {
            if (readability.isEditingKey(e)) { return; }
            var code = e.keyCode;
            if (code === 16) {
                readability.reversePageScroll = true;
                return;
            }

            if (code === 32) {
                readability.curScrollStep = 0;
                var windowHeight = window.innerHeight ? window.innerHeight : (document.documentElement.clientHeight ? document.documentElement.clientHeight : document.body.clientHeight);

                if(readability.reversePageScroll) {
                    readability.scrollTo(readability.scrollTop(), readability.scrollTop() - (windowHeight - 50), 20, 10);
                }
                else {
                    readability.scrollTo(readability.scrollTop(), readability.scrollTop() + (windowHeight - 50), 20, 10);
                }

                return false;
            }
        };

        document.onkeyup = function(e) {
            var code = (window.event) ? event.keyCode : e.keyCode;
            if (code === 16) {
                readability.reversePageScroll = false;
                return;
            }
        };
    },

    /**
     * Run any post-process modifications to article content as necessary.
     *
     * @param Element
     * @return void
    **/
    postProcessContent: function(articleContent) {
        if(readability.convertLinksToFootnotes && !window.location.href.match(/wikipedia\.org/g)) {
            readability.addFootnotes(articleContent);
        }

        readability.fixImageFloats(articleContent);
    },

    /**
     * Some content ends up looking ugly if the image is too large to be floated.
     * If the image is wider than a threshold (currently 55%), no longer float it,
     * center it instead.
     *
     * @param Element
     * @return void
    **/
    fixImageFloats: function (articleContent) {
        var imageWidthThreshold = Math.min(articleContent.offsetWidth, 800) * 0.55,
            images              = articleContent.getElementsByTagName('img');

        for(var i=0, il = images.length; i < il; i+=1) {
            var image = images[i];

            if(image.offsetWidth > imageWidthThreshold) {
                image.className += " blockImage";
            }
        }
    },

    /**
     * Get the article tools Element that has buttons like reload, print.
     *
     * @return void
     **/
    getArticleTools: function () {
        var articleTools = document.createElement("DIV");

        articleTools.id        = "readTools";
        /* Two explicit rows. Wrapping a single flex row instead would make the
           bar claim the full window width as soon as the second row appears. */
        /* No inline onclick anywhere: a page's Content Security Policy blocks
           inline handlers, which is why Print and Exit Reader silently did
           nothing on sites that send one (Medium among them). Every button is
           bound with addEventListener after the bar is inserted. */
        function btn(id, cls, iconName, label, title) {
            /* No label means an icon-only button, which needs the label as an
               accessible name instead. */
            return "<a href='#' role='button' id='" + id + "' class='" + cls + (label ? "" : " icon-only") +
                   "' title='" + title + "'" + (label ? "" : " aria-label='" + title + "'") + ">" +
                   "<svg class='lr-icon' viewBox='0 0 24 24' aria-hidden='true'>" + readability.ICONS[iconName] + "</svg>" +
                   (label ? "<span class='lr-text'>" + label + "</span>" : "") + "</a>";
        }

        /* Two explicit rows. Wrapping a single flex row instead would make the
           bar claim the full window width as soon as the second row appears.
           Variants carry the intent: one primary, the rest secondary, and the
           two that leave the reader demoted to ghost. */
        articleTools.innerHTML =
          "<span class='lr-row'>" +
            btn("send-notion",   "",        "send",     "Send to Notion",       "Save the article to your Notion workspace") +
            btn("save-markdown", "",        "download", "Save .md",             "Save the article as a .md file") +
            btn("copy-markdown", "",        "copy",     "Copy Markdown",        "Copy the article as Markdown") +
            btn("print-page",    "",        "printer",  "Print",                "Print this article") +
            btn("reload-page",   "",        "rotate",   "Exit Reader",          "Reload the original page") +
            btn("open-settings", "apart",   "settings",  "",                     "Notemill settings") +
          "</span>" +
          "<span id='readMarkdownStatus' class='lr-row' role='status' aria-live='polite'></span>";

        return articleTools;
    },

    /**
     * retuns the suggested direction of the string
     *
     * @return "rtl" || "ltr"
     **/
    getSuggestedDirection: function(text) {
        function sanitizeText() {
            return text.replace(/@\w+/, "");
        }

        function countMatches(match) {
            var matches = text.match(new RegExp(match, "g"));
            return matches !== null ? matches.length : 0;
        }

        function isRTL() {
            var count_heb =  countMatches("[\\u05B0-\\u05F4\\uFB1D-\\uFBF4]");
            var count_arb =  countMatches("[\\u060C-\\u06FE\\uFB50-\\uFEFC]");

            // if 20% of chars are Hebrew or Arbic then direction is rtl
            return  (count_heb + count_arb) * 100 / text.length > 20;
        }

        text  = sanitizeText(text);
        return isRTL() ? "rtl" : "ltr";
    },


    /**
     * Get the article title as an H1.
     *
     * @return void
     **/
    getArticleTitle: function () {
        var curTitle = "",
            origTitle = "";

        try {
            curTitle = origTitle = document.title;

            if(typeof curTitle !== "string") { /* If they had an element with id "title" in their HTML */
                curTitle = origTitle = readability.getInnerText(document.getElementsByTagName('title')[0]);
            }
        }
        catch(e) {}

        if(curTitle.match(/ [\|\-] /))
        {
            curTitle = origTitle.replace(/(.*)[\|\-] .*/gi,'$1');

            if(curTitle.split(' ').length < 3) {
                curTitle = origTitle.replace(/[^\|\-]*[\|\-](.*)/gi,'$1');
            }
        }
        else if(curTitle.indexOf(': ') !== -1)
        {
            curTitle = origTitle.replace(/.*:(.*)/gi, '$1');

            if(curTitle.split(' ').length < 3) {
                curTitle = origTitle.replace(/[^:]*[:](.*)/gi,'$1');
            }
        }
        else if(curTitle.length > 150 || curTitle.length < 15)
        {
            var hOnes = document.getElementsByTagName('h1');
            if(hOnes.length === 1)
            {
                curTitle = readability.getInnerText(hOnes[0]);
            }
        }

        curTitle = curTitle.replace( readability.regexps.trim, "" );

        if(curTitle.split(' ').length <= 4) {
            curTitle = origTitle;
        }

        var articleTitle = document.createElement("h1");
        articleTitle.innerHTML = curTitle;

        return articleTitle;
    },

    /**
     * Get the footer with the readability mark etc.
     *
     * @return void
     **/
    getArticleFooter: function () {
        var articleFooter = document.createElement("div");
        articleFooter.id = "readFooter";
        articleFooter.innerHTML = "<div id='rdb-footer-print'>Excerpted from <cite>" + document.title + "</cite><br><a href=\"" + window.location.href + "\">" + window.location.href + "</a></div>";
        return articleFooter;
    },

    /**
     * Prepare the HTML document for readability to scrape it.
     * This includes things like stripping javascript, CSS, and handling terrible markup.
     *
     * @return void
     **/
    prepDocument: function () {
        /**
         * In some cases a body element can't be found (if the HTML is totally hosed for example)
         * so we create a new body node and append it to the document.
         */
        if(document.body === null)
        {
            var body = document.createElement("body");
            try {
                document.body = body;
            }
            catch(e) {
                document.documentElement.appendChild(body);
                dbg(e);
            }
        }

        document.body.id = "readabilityBody";

        var frames = document.getElementsByTagName('frame');
        if(frames.length > 0)
        {
            var bestFrame = null;
            var bestFrameSize = 0;    /* The frame to try to run readability upon. Must be on same domain. */
            var biggestFrameSize = 0; /* Used for the error message. Can be on any domain. */
            for(var frameIndex = 0; frameIndex < frames.length; frameIndex+=1)
            {
                var frameSize = frames[frameIndex].offsetWidth + frames[frameIndex].offsetHeight;
                var canAccessFrame = false;
                try {
                    var frameBody = frames[frameIndex].contentWindow.document.body;
                    canAccessFrame = true;
                }
                catch(eFrames) {
                    dbg(eFrames);
                }

                if(frameSize > biggestFrameSize) {
                    biggestFrameSize         = frameSize;
                    readability.biggestFrame = frames[frameIndex];
                }

                if(canAccessFrame && frameSize > bestFrameSize)
                {
                    readability.frameHack = true;

                    bestFrame = frames[frameIndex];
                    bestFrameSize = frameSize;
                }
            }

            if(bestFrame)
            {
                var newBody = document.createElement('body');
                newBody.innerHTML = bestFrame.contentWindow.document.body.innerHTML;
                newBody.style.overflow = 'scroll';
                document.body = newBody;

                var frameset = document.getElementsByTagName('frameset')[0];
                if(frameset) {
                    frameset.parentNode.removeChild(frameset); }
            }
        }

        /* Remove all stylesheets */
        for (var k=0;k < document.styleSheets.length; k+=1) {
            if (document.styleSheets[k].href !== null && document.styleSheets[k].href.lastIndexOf("readability") === -1) {
                document.styleSheets[k].disabled = true;
            }
        }

        /* Remove all style tags in head (not doing this on IE) - TODO: Why not? */
        var styleTags = document.getElementsByTagName("style");
        for (var st=0;st < styleTags.length; st+=1) {
            styleTags[st].textContent = "";
        }

        /* Turn all double br's into p's */
        /* Note, this is pretty costly as far as processing goes. Maybe optimize later. */
        document.body.innerHTML = document.body.innerHTML.replace(readability.regexps.replaceBrs, '</p><p>').replace(readability.regexps.replaceFonts, '<$1span>');
    },

    /**
     * For easier reading, convert this document to have footnotes at the bottom rather than inline links.
     * @see http://www.roughtype.com/archives/2010/05/experiments_in.php
     *
     * @return void
    **/
    addFootnotes: function(articleContent) {
        var footnotesWrapper = document.getElementById('readability-footnotes'),
            articleFootnotes = document.getElementById('readability-footnotes-list');

        if(!footnotesWrapper) {
            footnotesWrapper               = document.createElement("div");
            footnotesWrapper.id            = 'readability-footnotes';
            footnotesWrapper.innerHTML     = '<h3>References</h3>';
            footnotesWrapper.style.display = 'none'; /* Until we know we have footnotes, don't show the references block. */

            articleFootnotes    = document.createElement('ol');
            articleFootnotes.id = 'readability-footnotes-list';

            footnotesWrapper.appendChild(articleFootnotes);

            var readFooter = document.getElementById('readFooter');

            if(readFooter) {
                readFooter.parentNode.insertBefore(footnotesWrapper, readFooter);
            }
        }

        var articleLinks = articleContent.getElementsByTagName('a');
        var linkCount    = articleFootnotes.getElementsByTagName('li').length;
        for (var i = 0; i < articleLinks.length; i+=1)
        {
            var articleLink  = articleLinks[i],
                footnoteLink = articleLink.cloneNode(true),
                refLink      = document.createElement('a'),
                footnote     = document.createElement('li'),
                linkDomain   = footnoteLink.host ? footnoteLink.host : document.location.host,
                linkText     = readability.getInnerText(articleLink);

            if(articleLink.className && articleLink.className.indexOf('readability-DoNotFootnote') !== -1 || linkText.match(readability.regexps.skipFootnoteLink)) {
                continue;
            }

            linkCount+=1;

            /** Add a superscript reference after the article link */
            refLink.href      = '#readabilityFootnoteLink-' + linkCount;
            refLink.innerHTML = '<small><sup>[' + linkCount + ']</sup></small>';
            refLink.className = 'readability-DoNotFootnote';
            try { refLink.style.color = 'inherit'; } catch(e) {} /* IE7 doesn't like inherit. */

            if(articleLink.parentNode.lastChild === articleLink) {
                articleLink.parentNode.appendChild(refLink);
            } else {
                articleLink.parentNode.insertBefore(refLink, articleLink.nextSibling);
            }

            articleLink.name        = 'readabilityLink-' + linkCount;
            try { articleLink.style.color = 'inherit'; } catch(err) {} /* IE7 doesn't like inherit. */

            footnote.innerHTML      = "<small><sup><a href='#readabilityLink-" + linkCount + "' title='Jump to Link in Article'>^</a></sup></small> ";

            footnoteLink.innerHTML  = (footnoteLink.title ? footnoteLink.title : linkText);
            footnoteLink.name       = 'readabilityFootnoteLink-' + linkCount;

            footnote.appendChild(footnoteLink);
            footnote.innerHTML = footnote.innerHTML + "<small> (" + linkDomain + ")</small>";

            articleFootnotes.appendChild(footnote);
        }

        if(linkCount > 0) {
            footnotesWrapper.style.display = 'block';
        }
    },

    useRdbTypekit: function () {
        var rdbHead      = document.getElementsByTagName('head')[0];
        var rdbTKScript  = document.createElement('script');
        var rdbTKCode    = null;

        var rdbTKLink    = document.createElement('a');
            rdbTKLink.setAttribute('class','rdbTK-powered');
            rdbTKLink.setAttribute('title','Fonts by Typekit');
            rdbTKLink.innerHTML = "Fonts by <span class='rdbTK'>Typekit</span>";

        if (readStyle === "style-athelas") {
            rdbTKCode = "sxt6vzy";
            dbg("Using Athelas Theme");

            rdbTKLink.setAttribute('href','http://typekit.com/?utm_source=readability&utm_medium=affiliate&utm_campaign=athelas');
            rdbTKLink.setAttribute('id','rdb-athelas');
            document.getElementById("rdb-footer-right").appendChild(rdbTKLink);
        }
        if (readStyle === "style-apertura") {
            rdbTKCode = "bae8ybu";
            dbg("Using Inverse Theme");

            rdbTKLink.setAttribute('href','http://typekit.com/?utm_source=readability&utm_medium=affiliate&utm_campaign=inverse');
            rdbTKLink.setAttribute('id','rdb-inverse');
            document.getElementById("rdb-footer-right").appendChild(rdbTKLink);
        }

        /**
         * Setting new script tag attributes to pull Typekits libraries
        **/
        rdbTKScript.setAttribute('type','text/javascript');
        rdbTKScript.setAttribute('src',"http://use.typekit.com/" + rdbTKCode + ".js");
        rdbTKScript.setAttribute('charset','UTF-8');
        rdbHead.appendChild(rdbTKScript);

        /**
         * In the future, maybe try using the following experimental Callback function?:
         * http://gist.github.com/192350
         * &
         * http://getsatisfaction.com/typekit/topics/support_a_pre_and_post_load_callback_function
        **/
        var typekitLoader = function() {
            dbg("Looking for Typekit.");
            if(typeof Typekit !== "undefined") {
                try {
                    dbg("Caught typekit");
                    Typekit.load();
                    clearInterval(window.typekitInterval);
                } catch(e) {
                    dbg("Typekit error: " + e);
                }
            }
        };

        window.typekitInterval = window.setInterval(typekitLoader, 100);
    },

    /**
     * Prepare the article node for display. Clean out any inline styles,
     * iframes, forms, strip extraneous <p> tags, etc.
     *
     * @param Element
     * @return void
     **/
    prepArticle: function (articleContent) {
        readability.cleanStyles(articleContent);
        readability.killBreaks(articleContent);

        /* Clean out junk from the article content */
        readability.cleanConditionally(articleContent, "form");
        readability.clean(articleContent, "object");
        readability.clean(articleContent, "h1");

        /**
         * If there is only one h2, they are probably using it
         * as a header and not a subheader, so remove it since we already have a header.
        ***/
        if(articleContent.getElementsByTagName('h2').length === 1) {
            readability.clean(articleContent, "h2");
        }
        readability.clean(articleContent, "iframe");

        readability.cleanHeaders(articleContent);

        /* Do these last as the previous stuff may have removed junk that will affect these */
        readability.cleanConditionally(articleContent, "table");
        readability.cleanConditionally(articleContent, "ul");
        readability.cleanConditionally(articleContent, "div");

        /* Remove extra paragraphs */
        var articleParagraphs = articleContent.getElementsByTagName('p');
        for(var i = articleParagraphs.length-1; i >= 0; i-=1) {
            var imgCount    = articleParagraphs[i].getElementsByTagName('img').length;
            var embedCount  = articleParagraphs[i].getElementsByTagName('embed').length;
            var objectCount = articleParagraphs[i].getElementsByTagName('object').length;

            if(imgCount === 0 && embedCount === 0 && objectCount === 0 && readability.getInnerText(articleParagraphs[i], false) === '') {
                articleParagraphs[i].parentNode.removeChild(articleParagraphs[i]);
            }
        }

        try {
            articleContent.innerHTML = articleContent.innerHTML.replace(/<br[^>]*>\s*<p/gi, '<p');
        }
        catch (e) {
            dbg("Cleaning innerHTML of breaks failed. This is an IE strict-block-elements bug. Ignoring.: " + e);
        }
    },

    /**
     * Initialize a node with the readability object. Also checks the
     * className/id for special names to add to its score.
     *
     * @param Element
     * @return void
    **/
    initializeNode: function (node) {
        node.readability = {"contentScore": 0};

        switch(node.tagName) {
            case 'DIV':
                node.readability.contentScore += 5;
                break;

            case 'PRE':
            case 'TD':
            case 'BLOCKQUOTE':
                node.readability.contentScore += 3;
                break;

            case 'ADDRESS':
            case 'OL':
            case 'UL':
            case 'DL':
            case 'DD':
            case 'DT':
            case 'LI':
            case 'FORM':
                node.readability.contentScore -= 3;
                break;

            case 'H1':
            case 'H2':
            case 'H3':
            case 'H4':
            case 'H5':
            case 'H6':
            case 'TH':
                node.readability.contentScore -= 5;
                break;
        }

        node.readability.contentScore += readability.getClassWeight(node);
    },

    /***
     * grabArticle - Using a variety of metrics (content score, classname, element types), find the content that is
     *               most likely to be the stuff a user wants to read. Then return it wrapped up in a div.
     *
     * @param page a document to run upon. Needs to be a full document, complete with body.
     * @return Element
    **/
    grabArticle: function (page) {
        var stripUnlikelyCandidates = readability.flagIsActive(readability.FLAG_STRIP_UNLIKELYS),
            isPaging = (page !== null) ? true: false;

        page = page ? page : document.body;

        var pageCacheHtml = page.innerHTML;

        var allElements = page.getElementsByTagName('*');

        /**
         * First, node prepping. Trash nodes that look cruddy (like ones with the class name "comment", etc), and turn divs
         * into P tags where they have been used inappropriately (as in, where they contain no other block level elements.)
         *
         * Note: Assignment from index for performance. See http://www.peachpit.com/articles/article.aspx?p=31567&seqNum=5
         * TODO: Shouldn't this be a reverse traversal?
        **/
        var node = null;
        var nodesToScore = [];
        for(var nodeIndex = 0; (node = allElements[nodeIndex]); nodeIndex+=1) {
            /* Remove unlikely candidates */
            if (stripUnlikelyCandidates) {
                var unlikelyMatchString = node.className + node.id;
                if (
                    (
                        unlikelyMatchString.search(readability.regexps.unlikelyCandidates) !== -1 &&
                        unlikelyMatchString.search(readability.regexps.okMaybeItsACandidate) === -1 &&
                        node.tagName !== "BODY"
                    )
                )
                {
                    dbg("Removing unlikely candidate - " + unlikelyMatchString);
                    node.parentNode.removeChild(node);
                    nodeIndex-=1;
                    continue;
                }
            }

            if (node.tagName === "P" || node.tagName === "TD" || node.tagName === "PRE") {
                nodesToScore[nodesToScore.length] = node;
            }

            /* Turn all divs that don't have children block level elements into p's */
            if (node.tagName === "DIV") {
                if (node.innerHTML.search(readability.regexps.divToPElements) === -1) {
                    var newNode = document.createElement('p');
                    try {
                        newNode.innerHTML = node.innerHTML;
                        node.parentNode.replaceChild(newNode, node);
                        nodeIndex-=1;

                        nodesToScore[nodesToScore.length] = node;
                    }
                    catch(e) {
                        dbg("Could not alter div to p, probably an IE restriction, reverting back to div.: " + e);
                    }
                }
                else
                {
                    /* EXPERIMENTAL */
                    for(var i = 0, il = node.childNodes.length; i < il; i+=1) {
                        var childNode = node.childNodes[i];
                        if(childNode.nodeType === 3) { // Node.TEXT_NODE
                            var p = document.createElement('p');
                            p.innerHTML = childNode.nodeValue;
                            p.style.display = 'inline';
                            p.className = 'readability-styled';
                            childNode.parentNode.replaceChild(p, childNode);
                        }
                    }
                }
            }
        }

        /**
         * Loop through all paragraphs, and assign a score to them based on how content-y they look.
         * Then add their score to their parent node.
         *
         * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
        **/
        var candidates = [];
        for (var pt=0; pt < nodesToScore.length; pt+=1) {
            var parentNode      = nodesToScore[pt].parentNode;
            var grandParentNode = parentNode ? parentNode.parentNode : null;
            var innerText       = readability.getInnerText(nodesToScore[pt]);

            if(!parentNode || typeof(parentNode.tagName) === 'undefined') {
                continue;
            }

            /* If this paragraph is less than 25 characters, don't even count it. */
            if(innerText.length < 25) {
                continue; }

            /* Initialize readability data for the parent. */
            if(typeof parentNode.readability === 'undefined') {
                readability.initializeNode(parentNode);
                candidates.push(parentNode);
            }

            /* Initialize readability data for the grandparent. */
            if(grandParentNode && typeof(grandParentNode.readability) === 'undefined' && typeof(grandParentNode.tagName) !== 'undefined') {
                readability.initializeNode(grandParentNode);
                candidates.push(grandParentNode);
            }

            var contentScore = 0;

            /* Add a point for the paragraph itself as a base. */
            contentScore+=1;

            /* Add points for any commas within this paragraph */
            contentScore += innerText.split(',').length;

            /* For every 100 characters in this paragraph, add another point. Up to 3 points. */
            contentScore += Math.min(Math.floor(innerText.length / 100), 3);

            /* Add the score to the parent. The grandparent gets half. */
            parentNode.readability.contentScore += contentScore;

            if(grandParentNode) {
                grandParentNode.readability.contentScore += contentScore/2;
            }
        }

        /**
         * After we've calculated scores, loop through all of the possible candidate nodes we found
         * and find the one with the highest score.
        **/
        var topCandidate = null;
        for(var c=0, cl=candidates.length; c < cl; c+=1)
        {
            /**
             * Scale the final candidates score based on link density. Good content should have a
             * relatively small link density (5% or less) and be mostly unaffected by this operation.
            **/
            candidates[c].readability.contentScore = candidates[c].readability.contentScore * (1-readability.getLinkDensity(candidates[c]));

            dbg('Candidate: ' + candidates[c] + " (" + candidates[c].className + ":" + candidates[c].id + ") with score " + candidates[c].readability.contentScore);

            if(!topCandidate || candidates[c].readability.contentScore > topCandidate.readability.contentScore) {
                topCandidate = candidates[c]; }
        }

        /**
         * If we still have no top candidate, just use the body as a last resort.
         * We also have to copy the body node so it is something we can modify.
         **/
        if (topCandidate === null || topCandidate.tagName === "body")
        {
            topCandidate = document.createElement("div");
            topCandidate.innerHTML = page.innerHTML;
            page.innerHTML = "";
            page.appendChild(topCandidate);
            readability.initializeNode(topCandidate);
        }

        /**
         * Rescue articles whose body is split across sibling wrappers.
         *
         * Modern CMSs (Medium, Substack, many WordPress themes) break a post
         * body into one wrapper per section, separated by headings, code
         * blocks and figures. Each wrapper is scored on its own, so the
         * wrapper holding the most paragraphs wins and the remaining sections
         * are never reached - the sibling pass below only inspects siblings of
         * the candidate, and the other sections sit in their own wrappers.
         *
         * An <article> ancestor is an explicit statement by the page that
         * everything inside it is the article, so prefer it when it holds
         * substantially more text than the candidate. Link density is the
         * guard against swallowing nav rails or related-post lists: prose is
         * mostly text, furniture is mostly links.
        **/
        var articleAncestor = null;
        for (var anc = topCandidate.parentNode; anc && anc.nodeType === 1; anc = anc.parentNode) {
            if (anc.tagName === "BODY" || anc.tagName === "HTML") { break; }
            if (anc.tagName === "ARTICLE") { articleAncestor = anc; break; }
        }

        if (articleAncestor !== null) {
            var candidateLength = readability.getInnerText(topCandidate, false).length;
            var ancestorLength  = readability.getInnerText(articleAncestor, false).length;

            if (ancestorLength >= candidateLength * readability.SECTIONED_ARTICLE_MIN_GAIN &&
                readability.getLinkDensity(articleAncestor) < readability.SECTIONED_ARTICLE_MAX_LINK_DENSITY)
            {
                dbg("Top candidate covered only " + candidateLength + " of " + ancestorLength +
                    " chars; promoting the <article> ancestor.");

                if (typeof articleAncestor.readability === 'undefined') {
                    readability.initializeNode(articleAncestor);
                }
                articleAncestor.readability.contentScore =
                    Math.max(articleAncestor.readability.contentScore, topCandidate.readability.contentScore);
                topCandidate = articleAncestor;
            }
        }

        /**
         * Now that we have the top candidate, look through its siblings for content that might also be related.
         * Things like preambles, content split by ads that we removed, etc.
        **/
        var articleContent        = document.createElement("div");
        if (isPaging) {
            articleContent.id     = "readability-content";
        }
        var siblingScoreThreshold = Math.max(10, topCandidate.readability.contentScore * 0.2);
        var siblingNodes          = topCandidate.parentNode.childNodes;


        for(var s=0, sl=siblingNodes.length; s < sl; s+=1) {
            var siblingNode = siblingNodes[s];
            var append      = false;

            /**
             * Fix for odd IE7 Crash where siblingNode does not exist even though this should be a live nodeList.
             * Example of error visible here: http://www.esquire.com/features/honesty0707
            **/
            if(!siblingNode) {
                continue;
            }

            dbg("Looking at sibling node: " + siblingNode + " (" + siblingNode.className + ":" + siblingNode.id + ")" + ((typeof siblingNode.readability !== 'undefined') ? (" with score " + siblingNode.readability.contentScore) : ''));
            dbg("Sibling has score " + (siblingNode.readability ? siblingNode.readability.contentScore : 'Unknown'));

            if(siblingNode === topCandidate)
            {
                append = true;
            }

            var contentBonus = 0;
            /* Give a bonus if sibling nodes and top candidates have the example same classname */
            if(siblingNode.className === topCandidate.className && topCandidate.className !== "") {
                contentBonus += topCandidate.readability.contentScore * 0.2;
            }

            if(typeof siblingNode.readability !== 'undefined' && (siblingNode.readability.contentScore+contentBonus) >= siblingScoreThreshold)
            {
                append = true;
            }

            if(siblingNode.nodeName === "P") {
                var linkDensity = readability.getLinkDensity(siblingNode);
                var nodeContent = readability.getInnerText(siblingNode);
                var nodeLength  = nodeContent.length;

                if(nodeLength > 80 && linkDensity < 0.25)
                {
                    append = true;
                }
                else if(nodeLength < 80 && linkDensity === 0 && nodeContent.search(/\.( |$)/) !== -1)
                {
                    append = true;
                }
            }

            if(append) {
                dbg("Appending node: " + siblingNode);

                var nodeToAppend = null;
                if(siblingNode.nodeName !== "DIV" && siblingNode.nodeName !== "P") {
                    /* We have a node that isn't a common block level element, like a form or td tag. Turn it into a div so it doesn't get filtered out later by accident. */

                    dbg("Altering siblingNode of " + siblingNode.nodeName + ' to div.');
                    nodeToAppend = document.createElement("div");
                    try {
                        nodeToAppend.id = siblingNode.id;
                        nodeToAppend.innerHTML = siblingNode.innerHTML;
                    }
                    catch(er) {
                        dbg("Could not alter siblingNode to div, probably an IE restriction, reverting back to original.");
                        nodeToAppend = siblingNode;
                        s-=1;
                        sl-=1;
                    }
                } else {
                    nodeToAppend = siblingNode;
                    s-=1;
                    sl-=1;
                }

                /* To ensure a node does not interfere with readability styles, remove its classnames */
                nodeToAppend.className = "";

                /* Append sibling and subtract from our list because it removes the node when you append to another node */
                articleContent.appendChild(nodeToAppend);
            }
        }

        /**
         * So we have all of the content that we need. Now we clean it up for presentation.
        **/
        readability.prepArticle(articleContent);

        if (readability.curPageNum === 1) {
            articleContent.innerHTML = '<div id="readability-page-1" class="page">' + articleContent.innerHTML + '</div>';
        }

        /**
         * Now that we've gone through the full algorithm, check to see if we got any meaningful content.
         * If we didn't, we may need to re-run grabArticle with different flags set. This gives us a higher
         * likelihood of finding the content, and the sieve approach gives us a higher likelihood of
         * finding the -right- content.
        **/
        if(readability.getInnerText(articleContent, false).length < 250) {
        page.innerHTML = pageCacheHtml;

            if (readability.flagIsActive(readability.FLAG_STRIP_UNLIKELYS)) {
                readability.removeFlag(readability.FLAG_STRIP_UNLIKELYS);
                return readability.grabArticle(page);
            }
            else if (readability.flagIsActive(readability.FLAG_WEIGHT_CLASSES)) {
                readability.removeFlag(readability.FLAG_WEIGHT_CLASSES);
                return readability.grabArticle(page);
            }
            else if (readability.flagIsActive(readability.FLAG_CLEAN_CONDITIONALLY)) {
                readability.removeFlag(readability.FLAG_CLEAN_CONDITIONALLY);
                return readability.grabArticle(page);
            } else {
                return null;
            }
        }

        return articleContent;
    },

    /**
     * Removes script tags from the document.
     *
     * @param Element
    **/
    removeScripts: function (doc) {
        var scripts = doc.getElementsByTagName('script');
        for(var i = scripts.length-1; i >= 0; i-=1)
        {
            if(typeof(scripts[i].src) === "undefined" || (scripts[i].src.indexOf('readability') === -1 && scripts[i].src.indexOf('typekit') === -1))
            {
                scripts[i].nodeValue="";
                scripts[i].removeAttribute('src');
                if (scripts[i].parentNode) {
                        scripts[i].parentNode.removeChild(scripts[i]);
                }
            }
        }
    },

    /**
     * Get the inner text of a node - cross browser compatibly.
     * This also strips out any excess whitespace to be found.
     *
     * @param Element
     * @return string
    **/
    getInnerText: function (e, normalizeSpaces) {
        var textContent    = "";

        if(typeof(e.textContent) === "undefined" && typeof(e.innerText) === "undefined") {
            return "";
        }

        normalizeSpaces = (typeof normalizeSpaces === 'undefined') ? true : normalizeSpaces;

        if (navigator.appName === "Microsoft Internet Explorer") {
            textContent = e.innerText.replace( readability.regexps.trim, "" ); }
        else {
            textContent = e.textContent.replace( readability.regexps.trim, "" ); }

        if(normalizeSpaces) {
            return textContent.replace( readability.regexps.normalize, " "); }
        else {
            return textContent; }
    },

    /**
     * Get the number of times a string s appears in the node e.
     *
     * @param Element
     * @param string - what to split on. Default is ","
     * @return number (integer)
    **/
    getCharCount: function (e,s) {
        s = s || ",";
        return readability.getInnerText(e).split(s).length-1;
    },

    /**
     * Remove the style attribute on every e and under.
     * TODO: Test if getElementsByTagName(*) is faster.
     *
     * @param Element
     * @return void
    **/
    cleanStyles: function (e) {
        e = e || document;
        var cur = e.firstChild;

        if(!e) {
            return; }

        // Remove any root styles, if we're able.
        if(typeof e.removeAttribute === 'function' && e.className !== 'readability-styled') {
            e.removeAttribute('style'); }

        // Go until there are no more child nodes
        while ( cur !== null ) {
            if ( cur.nodeType === 1 ) {
                // Remove style attribute(s) :
                if(cur.className !== "readability-styled") {
                    cur.removeAttribute("style");
                }
                readability.cleanStyles( cur );
            }
            cur = cur.nextSibling;
        }
    },

    /**
     * Get the density of links as a percentage of the content
     * This is the amount of text that is inside a link divided by the total text in the node.
     *
     * @param Element
     * @return number (float)
    **/
    getLinkDensity: function (e) {
        var links      = e.getElementsByTagName("a");
        var textLength = readability.getInnerText(e).length;
        var linkLength = 0;
        for(var i=0, il=links.length; i<il;i+=1)
        {
            linkLength += readability.getInnerText(links[i]).length;
        }

        return linkLength / textLength;
    },

    /**
     * Find a cleaned up version of the current URL, to use for comparing links for possible next-pageyness.
     *
     * @author Dan Lacy
     * @return string the base url
    **/
    findBaseUrl: function () {
        var noUrlParams     = window.location.pathname.split("?")[0],
            urlSlashes      = noUrlParams.split("/").reverse(),
            cleanedSegments = [],
            possibleType    = "";

        for (var i = 0, slashLen = urlSlashes.length; i < slashLen; i+=1) {
            var segment = urlSlashes[i];

            // Split off and save anything that looks like a file type.
            if (segment.indexOf(".") !== -1) {
                possibleType = segment.split(".")[1];

                /* If the type isn't alpha-only, it's probably not actually a file extension. */
                if(!possibleType.match(/[^a-zA-Z]/)) {
                    segment = segment.split(".")[0];
                }
            }

            /**
             * EW-CMS specific segment replacement. Ugly.
             * Example: http://www.ew.com/ew/article/0,,20313460_20369436,00.html
            **/
            if(segment.indexOf(',00') !== -1) {
                segment = segment.replace(',00', '');
            }

            // If our first or second segment has anything looking like a page number, remove it.
            if (segment.match(/((_|-)?p[a-z]*|(_|-))[0-9]{1,2}$/i) && ((i === 1) || (i === 0))) {
                segment = segment.replace(/((_|-)?p[a-z]*|(_|-))[0-9]{1,2}$/i, "");
            }


            var del = false;

            /* If this is purely a number, and it's the first or second segment, it's probably a page number. Remove it. */
            if (i < 2 && segment.match(/^\d{1,2}$/)) {
                del = true;
            }

            /* If this is the first segment and it's just "index", remove it. */
            if(i === 0 && segment.toLowerCase() === "index") {
                del = true;
            }

            /* If our first or second segment is smaller than 3 characters, and the first segment was purely alphas, remove it. */
            if(i < 2 && segment.length < 3 && !urlSlashes[0].match(/[a-z]/i)) {
                del = true;
            }

            /* If it's not marked for deletion, push it to cleanedSegments. */
            if (!del) {
                cleanedSegments.push(segment);
            }
        }

        // This is our final, cleaned, base article URL.
        return window.location.protocol + "//" + window.location.host + cleanedSegments.reverse().join("/");
    },

    /**
     * Look for any paging links that may occur within the document.
     *
     * @param body
     * @return object (array)
    **/
    findNextPageLink: function (elem) {
        var possiblePages = {},
            allLinks = elem.getElementsByTagName('a'),
            articleBaseUrl = readability.findBaseUrl();

        /**
         * Loop through all links, looking for hints that they may be next-page links.
         * Things like having "page" in their textContent, className or id, or being a child
         * of a node with a page-y className or id.
         *
         * Also possible: levenshtein distance? longest common subsequence?
         *
         * After we do that, assign each page a score, and
        **/
        for(var i = 0, il = allLinks.length; i < il; i+=1) {
            var link     = allLinks[i],
                linkHref = allLinks[i].href.replace(/#.*$/, '').replace(/\/$/, '');

            /* If we've already seen this page, ignore it */
            if(linkHref === "" || linkHref === articleBaseUrl || linkHref === window.location.href || linkHref in readability.parsedPages) {
                continue;
            }

            /* If it's on a different domain, skip it. */
            if(window.location.host !== linkHref.split(/\/+/g)[1]) {
                continue;
            }

            var linkText = readability.getInnerText(link);

            /* If the linkText looks like it's not the next page, skip it. */
            if(linkText.match(readability.regexps.extraneous) || linkText.length > 25) {
                continue;
            }

            /* If the leftovers of the URL after removing the base URL don't contain any digits, it's certainly not a next page link. */
            var linkHrefLeftover = linkHref.replace(articleBaseUrl, '');
            if(!linkHrefLeftover.match(/\d/)) {
                continue;
            }

            if(!(linkHref in possiblePages)) {
                possiblePages[linkHref] = {"score": 0, "linkText": linkText, "href": linkHref};
            } else {
                possiblePages[linkHref].linkText += ' | ' + linkText;
            }

            var linkObj = possiblePages[linkHref];

            /**
             * If the articleBaseUrl isn't part of this URL, penalize this link. It could still be the link, but the odds are lower.
             * Example: http://www.actionscript.org/resources/articles/745/1/JavaScript-and-VBScript-Injection-in-ActionScript-3/Page1.html
            **/
            if(linkHref.indexOf(articleBaseUrl) !== 0) {
                linkObj.score -= 25;
            }

            var linkData = linkText + ' ' + link.className + ' ' + link.id;
            if(linkData.match(readability.regexps.nextLink)) {
                linkObj.score += 50;
            }
            if(linkData.match(/pag(e|ing|inat)/i)) {
                linkObj.score += 25;
            }
            if(linkData.match(/(first|last)/i)) { // -65 is enough to negate any bonuses gotten from a > or » in the text,
                /* If we already matched on "next", last is probably fine. If we didn't, then it's bad. Penalize. */
                if(!linkObj.linkText.match(readability.regexps.nextLink)) {
                    linkObj.score -= 65;
                }
            }
            if(linkData.match(readability.regexps.negative) || linkData.match(readability.regexps.extraneous)) {
                linkObj.score -= 50;
            }
            if(linkData.match(readability.regexps.prevLink)) {
                linkObj.score -= 200;
            }

            /* If a parentNode contains page or paging or paginat */
            var parentNode = link.parentNode,
                positiveNodeMatch = false,
                negativeNodeMatch = false;
            while(parentNode) {
                var parentNodeClassAndId = parentNode.className + ' ' + parentNode.id;
                if(!positiveNodeMatch && parentNodeClassAndId && parentNodeClassAndId.match(/pag(e|ing|inat)/i)) {
                    positiveNodeMatch = true;
                    linkObj.score += 25;
                }
                if(!negativeNodeMatch && parentNodeClassAndId && parentNodeClassAndId.match(readability.regexps.negative)) {
                    /* If this is just something like "footer", give it a negative. If it's something like "body-and-footer", leave it be. */
                    if(!parentNodeClassAndId.match(readability.regexps.positive)) {
                        linkObj.score -= 25;
                        negativeNodeMatch = true;
                    }
                }

                parentNode = parentNode.parentNode;
            }

            /**
             * If the URL looks like it has paging in it, add to the score.
             * Things like /page/2/, /pagenum/2, ?p=3, ?page=11, ?pagination=34
            **/
            if (linkHref.match(/p(a|g|ag)?(e|ing|ination)?(=|\/)[0-9]{1,2}/i) || linkHref.match(/(page|paging)/i)) {
                linkObj.score += 25;
            }

            /* If the URL contains negative values, give a slight decrease. */
            if (linkHref.match(readability.regexps.extraneous)) {
                linkObj.score -= 15;
            }

            /**
             * Minor punishment to anything that doesn't match our current URL.
             * NOTE: I'm finding this to cause more harm than good where something is exactly 50 points.
             *       Dan, can you show me a counterexample where this is necessary?
             * if (linkHref.indexOf(window.location.href) !== 0) {
             *    linkObj.score -= 1;
             * }
            **/

            /**
             * If the link text can be parsed as a number, give it a minor bonus, with a slight
             * bias towards lower numbered pages. This is so that pages that might not have 'next'
             * in their text can still get scored, and sorted properly by score.
            **/
            var linkTextAsNumber = parseInt(linkText, 10);
            if(linkTextAsNumber) {
                // Punish 1 since we're either already there, or it's probably before what we want anyways.
                if (linkTextAsNumber === 1) {
                    linkObj.score -= 10;
                }
                else {
                    // Todo: Describe this better
                    linkObj.score += Math.max(0, 10 - linkTextAsNumber);
                }
            }
        }

        /**
         * Loop thrugh all of our possible pages from above and find our top candidate for the next page URL.
         * Require at least a score of 50, which is a relatively high confidence that this page is the next link.
        **/
        var topPage = null;
        for(var page in possiblePages) {
            if(possiblePages.hasOwnProperty(page)) {
                if(possiblePages[page].score >= 50 && (!topPage || topPage.score < possiblePages[page].score)) {
                    topPage = possiblePages[page];
                }
            }
        }

        if(topPage) {
            var nextHref = topPage.href.replace(/\/$/,'');

            dbg('NEXT PAGE IS ' + nextHref);
            readability.parsedPages[nextHref] = true;
            return nextHref;
        }
        else {
            return null;
        }
    },

    /**
     * Build a simple cross browser compatible XHR.
     *
     * TODO: This could likely be simplified beyond what we have here right now. There's still a bit of excess junk.
    **/
    xhr: function () {
        if (typeof XMLHttpRequest !== 'undefined' && (window.location.protocol !== 'file:' || !window.ActiveXObject)) {
            return new XMLHttpRequest();
        }
        else {
            try { return new ActiveXObject('Msxml2.XMLHTTP.6.0'); } catch(sixerr) { }
            try { return new ActiveXObject('Msxml2.XMLHTTP.3.0'); } catch(threrr) { }
            try { return new ActiveXObject('Msxml2.XMLHTTP'); } catch(err) { }
        }

        return false;
    },

    successfulRequest: function (request) {
        return (request.status >= 200 && request.status < 300) || request.status === 304 || (request.status === 0 && request.responseText);
    },

    ajax: function (url, options) {
        var request = readability.xhr();

        function respondToReadyState(readyState) {
            if (request.readyState === 4) {
                if (readability.successfulRequest(request)) {
                    if (options.success) { options.success(request); }
                }
                else {
                    if (options.error) { options.error(request); }
                }
            }
        }

        if (typeof options === 'undefined') { options = {}; }

        request.onreadystatechange = respondToReadyState;

        request.open('get', url, true);
        request.setRequestHeader('Accept', 'text/html');

        try {
            request.send(options.postBody);
        }
        catch (e) {
            if (options.error) { options.error(); }
        }

        return request;
    },

    /**
     * Make an AJAX request for each page and append it to the document.
    **/
    curPageNum: 1,

    appendNextPage: function (nextPageLink) {
        readability.curPageNum+=1;

        var articlePage       = document.createElement("div");
        articlePage.id        = 'readability-page-' + readability.curPageNum;
        articlePage.className = 'page';
        articlePage.innerHTML = '<p class="page-separator" title="Page ' + readability.curPageNum + '">&sect;</p>';

        document.getElementById("readability-content").appendChild(articlePage);

        if(readability.curPageNum > readability.maxPages) {
            var nextPageMarkup = "<div style='text-align: center'><a href='" + nextPageLink + "'>View Next Page</a></div>";

            articlePage.innerHTML = articlePage.innerHTML + nextPageMarkup;
            return;
        }

        /**
         * Now that we've built the article page DOM element, get the page content
         * asynchronously and load the cleaned content into the div we created for it.
        **/
        (function(pageUrl, thisPage) {
            readability.ajax(pageUrl, {
                success: function(r) {

                    /* First, check to see if we have a matching ETag in headers - if we do, this is a duplicate page. */
                    var eTag = r.getResponseHeader('ETag');
                    if(eTag) {
                        if(eTag in readability.pageETags) {
                            dbg("Exact duplicate page found via ETag. Aborting.");
                            articlePage.style.display = 'none';
                            return;
                        } else {
                            readability.pageETags[eTag] = 1;
                        }
                    }

                    // TODO: this ends up doubling up page numbers on NYTimes articles. Need to generically parse those away.
                    var page = document.createElement("div");

                    /**
                     * Do some preprocessing to our HTML to make it ready for appending.
                     * • Remove any script tags. Swap and reswap newlines with a unicode character because multiline regex doesn't work in javascript.
                     * • Turn any noscript tags into divs so that we can parse them. This allows us to find any next page links hidden via javascript.
                     * • Turn all double br's into p's - was handled by prepDocument in the original view.
                     *   Maybe in the future abstract out prepDocument to work for both the original document and AJAX-added pages.
                    **/
                    var responseHtml = r.responseText.replace(/\n/g,'\uffff').replace(/<script.*?>.*?<\/script>/gi, '');
                    responseHtml = responseHtml.replace(/\n/g,'\uffff').replace(/<script.*?>.*?<\/script>/gi, '');
                    responseHtml = responseHtml.replace(/\uffff/g,'\n').replace(/<(\/?)noscript/gi, '<$1div');
                    responseHtml = responseHtml.replace(readability.regexps.replaceBrs, '</p><p>');
                    responseHtml = responseHtml.replace(readability.regexps.replaceFonts, '<$1span>');

                    page.innerHTML = responseHtml;

                    /**
                     * Reset all flags for the next page, as they will search through it and disable as necessary at the end of grabArticle.
                    **/
                    readability.flags = 0x1 | 0x2 | 0x4;

                    var nextPageLink = readability.findNextPageLink(page),
                        content      =  readability.grabArticle(page);

                    if(!content) {
                        dbg("No content found in page to append. Aborting.");
                        return;
                    }

                    /**
                     * Anti-duplicate mechanism. Essentially, get the first paragraph of our new page.
                     * Compare it against all of the the previous document's we've gotten. If the previous
                     * document contains exactly the innerHTML of this first paragraph, it's probably a duplicate.
                    **/
                    var firstP = content.getElementsByTagName("P").length ? content.getElementsByTagName("P")[0] : null;
                    if(firstP && firstP.innerHTML.length > 100) {
                        for(var i=1; i <= readability.curPageNum; i+=1) {
                            var rPage = document.getElementById('readability-page-' + i);
                            if(rPage && rPage.innerHTML.indexOf(firstP.innerHTML) !== -1) {
                                dbg('Duplicate of page ' + i + ' - skipping.');
                                articlePage.style.display = 'none';
                                readability.parsedPages[pageUrl] = true;
                                return;
                            }
                        }
                    }

                    readability.removeScripts(content);

                    thisPage.innerHTML = thisPage.innerHTML + content.innerHTML;

                    /**
                     * After the page has rendered, post process the content. This delay is necessary because,
                     * in webkit at least, offsetWidth is not set in time to determine image width. We have to
                     * wait a little bit for reflow to finish before we can fix floating images.
                    **/
                    window.setTimeout(
                        function() { readability.postProcessContent(thisPage); },
                        500
                    );

                    if(nextPageLink) {
                        readability.appendNextPage(nextPageLink);
                    }
                }
            });
        }(nextPageLink, articlePage));
    },

    /**
     * Get an elements class/id weight. Uses regular expressions to tell if this
     * element looks good or bad.
     *
     * @param Element
     * @return number (Integer)
    **/
    getClassWeight: function (e) {
        if(!readability.flagIsActive(readability.FLAG_WEIGHT_CLASSES)) {
            return 0;
        }

        var weight = 0;

        /* Look for a special classname */
        if (typeof(e.className) === 'string' && e.className !== '')
        {
            if(e.className.search(readability.regexps.negative) !== -1) {
                weight -= 25; }

            if(e.className.search(readability.regexps.positive) !== -1) {
                weight += 25; }
        }

        /* Look for a special ID */
        if (typeof(e.id) === 'string' && e.id !== '')
        {
            if(e.id.search(readability.regexps.negative) !== -1) {
                weight -= 25; }

            if(e.id.search(readability.regexps.positive) !== -1) {
                weight += 25; }
        }

        return weight;
    },

    nodeIsVisible: function (node) {
        return (node.offsetWidth !== 0 || node.offsetHeight !== 0) && node.style.display.toLowerCase() !== 'none';
    },

    /**
     * Remove extraneous break tags from a node.
     *
     * @param Element
     * @return void
     **/
    killBreaks: function (e) {
        try {
            e.innerHTML = e.innerHTML.replace(readability.regexps.killBreaks,'<br />');
        }
        catch (eBreaks) {
            dbg("KillBreaks failed - this is an IE bug. Ignoring.: " + eBreaks);
        }
    },

    /**
     * Clean a node of all elements of type "tag".
     * (Unless it's a youtube/vimeo video. People love movies.)
     *
     * @param Element
     * @param string tag to clean
     * @return void
     **/
    clean: function (e, tag) {
        var targetList = e.getElementsByTagName( tag );
        var isEmbed    = (tag === 'object' || tag === 'embed');

        for (var y=targetList.length-1; y >= 0; y-=1) {
            /* Allow youtube and vimeo videos through as people usually want to see those. */
            if(isEmbed) {
                var attributeValues = "";
                for (var i=0, il=targetList[y].attributes.length; i < il; i+=1) {
                    attributeValues += targetList[y].attributes[i].value + '|';
                }

                /* First, check the elements attributes to see if any of them contain youtube or vimeo */
                if (attributeValues.search(readability.regexps.videos) !== -1) {
                    continue;
                }

                /* Then check the elements inside this element for the same. */
                if (targetList[y].innerHTML.search(readability.regexps.videos) !== -1) {
                    continue;
                }

            }

            targetList[y].parentNode.removeChild(targetList[y]);
        }
    },

    /**
     * Clean an element of all tags of type "tag" if they look fishy.
     * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
     *
     * @return void
     **/
    /**
     * Upgrade an image URL to its full-resolution original.
     *
     * CDNs encode the delivered size in the URL, so the markup usually points
     * at a downscaled variant. Strip the sizing directive and the original is
     * served from the same path. Unknown hosts are returned untouched - a
     * wrong guess would break the image, and the displayed size is a safe
     * fallback.
     *
     * @param String
     * @return String
    **/
    fullResImageURL: function (url) {
        if (!url || url.indexOf("data:") === 0) { return url; }

        var out = url;

        /* Medium: /v2/resize:fit:1400/format:webp/0*abc -> /v2/0*abc */
        if (/(^|\.)miro\.medium\.com/.test(out)) {
            out = out.replace(/\/(resize:(fit|fill):[0-9:]+|format:[a-z]+)/g, "");
        }

        /* Substack and other Cloudinary-style fetchers embed the original,
           URL-encoded, as the last path segment. */
        var embedded = out.match(/\/(https?%3A%2F%2F[^/]+)$/i);
        if (embedded) {
            try { out = decodeURIComponent(embedded[1]); } catch (e) { /* keep out */ }
        }

        /* WordPress / generic: ?w=800&h=600 or ?width=800 */
        out = out.replace(/([?&])(w|h|width|height|fit|q|quality|dpr)=[^&]*/g, "$1")
                 .replace(/[?&]+$/, "")
                 .replace(/\?&/, "?");

        return out;
    },

    /**
     * Record the best available source for every image before the document is
     * rewritten, and point content images at it.
     *
     * srcset is the browser's own list of candidates and is lost once the
     * article is reassembled, so the widest entry is captured here while it is
     * still available. Only content-sized images are upgraded: fetching the
     * original of a 64px avatar would cost megabytes for no visible gain.
     *
     * @param Element
     * @return void
    **/
    upgradeImages: function (container) {
        var imgs = container.getElementsByTagName("img");

        for (var i = 0, il = imgs.length; i < il; i += 1) {
            var img  = imgs[i];
            var best = img.currentSrc || img.getAttribute("src") || "";
            var widest = 0;

            var srcset = img.getAttribute("srcset") || "";
            if (srcset) {
                var parts = srcset.split(",");
                for (var c = 0; c < parts.length; c += 1) {
                    var bits = parts[c].trim().split(/\s+/);
                    if (!bits[0]) { continue; }
                    var w = parseInt((bits[1] || "").replace(/[wx]$/, ""), 10) || 0;
                    if (w >= widest) { widest = w; best = bits[0]; }
                }
            }

            var full = readability.fullResImageURL(best);
            if (full) { img.setAttribute("data-notemill-fullres", full); }

            /* Only swap the live src for images big enough to be content. */
            var rw = img.offsetWidth  || img.naturalWidth  || parseInt(img.getAttribute("width"), 10)  || 0;
            var rh = img.offsetHeight || img.naturalHeight || parseInt(img.getAttribute("height"), 10) || 0;
            if (full && rw >= readability.CONTENT_IMAGE_MIN_WIDTH && rh >= readability.CONTENT_IMAGE_MIN_HEIGHT) {
                img.setAttribute("src", full);
                img.removeAttribute("srcset");
                img.removeAttribute("sizes");
            }
        }
    },

    /**
     * The text of a <pre>, with its line structure intact.
     *
     * textContent is not enough: many sites break code lines with <br>, or wrap
     * each line in its own <div>/<span> (Prism, Medium, Ghost). Those produce no
     * newline characters at all, so textContent returns one run-on line - which
     * is what reached Notion before this existed.
     *
     * @param Element
     * @return String
    **/
    preformattedText: function (pre) {
        var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|BUTTON|INPUT|SELECT|TEXTAREA)$/;
        var LINE = /^(DIV|P|LI|TR|SECTION|ARTICLE|HEADER|FOOTER|PRE|OL|UL|TABLE|TBODY)$/;
        var out  = "";

        function nl() { if (out && !/\n$/.test(out)) { out += "\n"; } }

        (function walk(node) {
            for (var i = 0; i < node.childNodes.length; i += 1) {
                var n = node.childNodes[i];
                if (n.nodeType === 3) { out += n.nodeValue; continue; }
                if (n.nodeType !== 1 || SKIP.test(n.tagName)) { continue; }
                if (n.tagName === "BR") { out += "\n"; continue; }
                if (LINE.test(n.tagName)) { nl(); walk(n); nl(); }
                else { walk(n); }
            }
        }(pre));

        return out.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "");
    },

    /**
     * Serialise the extracted article as Notion API blocks.
     *
     * Mirrors toMarkdown: walks the reassembled content so the page created in
     * Notion is what the reader sees. Respects the API's limits - 2000 chars
     * per rich-text item, 100 items per block, one level of list nesting.
     *
     * @param Element
     * @return Array of block objects
    **/
    toNotionBlocks: function (root) {
        var INLINE_SKIP = /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|BUTTON|INPUT|SELECT|TEXTAREA)$/;
        var TEXT_MAX    = 2000;
        var ITEMS_MAX   = 100;
        var LANGUAGES   = {
            js: "javascript", javascript: "javascript", jsx: "javascript",
            ts: "typescript", typescript: "typescript", tsx: "typescript",
            py: "python", python: "python", rb: "ruby", ruby: "ruby",
            sh: "shell", bash: "bash", zsh: "shell", shell: "shell", console: "shell",
            json: "json", yaml: "yaml", yml: "yaml", xml: "xml", toml: "toml",
            html: "html", css: "css", scss: "scss", sql: "sql", graphql: "graphql",
            java: "java", kotlin: "kotlin", swift: "swift", go: "go", golang: "go",
            rust: "rust", c: "c", cpp: "c++", "c++": "c++", cs: "c#", csharp: "c#",
            php: "php", r: "r", scala: "scala", lua: "lua", perl: "perl", dart: "dart",
            docker: "docker", dockerfile: "docker", makefile: "makefile", md: "markdown",
            markdown: "markdown", diff: "diff", plain: "plain text", text: "plain text"
        };

        /* Notion rejects any link that is not a plain http(s) URL (and very long
           ones), and it fails the *whole* page, not just that link. Everything
           that becomes a link or an image src goes through here first. */
        function safeURL(u) {
            u = (u || "").trim();
            return (/^https?:\/\//i.test(u) && u.length <= 1900) ? u : null;
        }

        function text(content, ann, link) {
            var item = {type: "text", text: {content: content}};
            if (link) { item.text.link = {url: link}; }
            if (ann && (ann.bold || ann.italic || ann.code)) {
                item.annotations = {};
                if (ann.bold)   { item.annotations.bold   = true; }
                if (ann.italic) { item.annotations.italic = true; }
                if (ann.code)   { item.annotations.code   = true; }
            }
            return item;
        }

        function sameStyle(a, b) {
            var la = a.text.link ? a.text.link.url : "", lb = b.text.link ? b.text.link.url : "";
            return la === lb && JSON.stringify(a.annotations || {}) === JSON.stringify(b.annotations || {});
        }

        /* Merge neighbours, split long runs, cap the item count. */
        function pack(items) {
            var merged = [];
            for (var i = 0; i < items.length; i += 1) {
                var last = merged[merged.length - 1];
                if (last && sameStyle(last, items[i])) { last.text.content += items[i].text.content; }
                else { merged.push(items[i]); }
            }
            var out = [];
            for (var j = 0; j < merged.length; j += 1) {
                var c = merged[j].text.content;
                for (var p = 0; p < c.length; p += TEXT_MAX) {
                    var piece = Object.assign({}, merged[j], {text: Object.assign({}, merged[j].text, {content: c.slice(p, p + TEXT_MAX)})});
                    out.push(piece);
                }
            }
            if (out.length > ITEMS_MAX) {
                var tail = out.slice(ITEMS_MAX - 1).map(function (t) { return t.text.content; }).join("");
                out = out.slice(0, ITEMS_MAX - 1).concat([text(tail.slice(0, TEXT_MAX))]);
            }
            return out;
        }

        function inline(node, ann, link) {
            var out = [];
            for (var i = 0; i < node.childNodes.length; i += 1) {
                var n = node.childNodes[i];
                if (n.nodeType === 3) {
                    var s = n.nodeValue.replace(/\s+/g, " ");
                    if (s) { out.push(text(s, ann, link)); }
                    continue;
                }
                if (n.nodeType !== 1 || INLINE_SKIP.test(n.tagName)) { continue; }
                var tag = n.tagName;
                if (tag === "BR") { out.push(text("\n", ann, link)); }
                else if (tag === "IMG") { /* inline images become their own block via block() */ }
                else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
                    out.push(text(n.textContent.replace(/\s+/g, " "), Object.assign({}, ann, {code: true}), link));
                }
                else if (tag === "STRONG" || tag === "B") { out = out.concat(inline(n, Object.assign({}, ann, {bold: true}), link)); }
                else if (tag === "EM" || tag === "I")     { out = out.concat(inline(n, Object.assign({}, ann, {italic: true}), link)); }
                else if (tag === "A") {
                    out = out.concat(inline(n, ann, safeURL(n.getAttribute("href")) || link));
                }
                else { out = out.concat(inline(n, ann, link)); }
            }
            return out;
        }

        function richText(node, ann) {
            var items = inline(node, ann || {}, null);
            /* trim leading/trailing whitespace across the run */
            if (items.length) {
                items[0].text.content = items[0].text.content.replace(/^\s+/, "");
                items[items.length - 1].text.content = items[items.length - 1].text.content.replace(/\s+$/, "");
            }
            items = items.filter(function (t) { return t.text.content !== ""; });
            return pack(items);
        }

        function hasText(rt) {
            return rt.some(function (t) { return t.text.content.trim() !== ""; });
        }

        function simple(type, rt) {
            var b = {object: "block", type: type}; b[type] = {rich_text: rt}; return b;
        }

        function imageBlock(img, captionRT) {
            var src = img.getAttribute("data-notemill-fullres") ||
                      img.currentSrc || img.getAttribute("src") || "";
            src = safeURL(readability.fullResImageURL(src));
            if (!src) { return null; }
            var b = {object: "block", type: "image", image: {type: "external", external: {url: src}}};
            if (captionRT && hasText(captionRT)) { b.image.caption = captionRT; }
            return b;
        }

        function images(node, out) {
            var imgs = node.getElementsByTagName("img");
            for (var m = 0; m < imgs.length; m += 1) { var ib = imageBlock(imgs[m]); if (ib) { out.push(ib); } }
        }

        function language(pre) {
            var cls = (pre.className || "") + " " + ((pre.firstElementChild && pre.firstElementChild.className) || "");
            var m   = cls.match(/(?:language|lang)-([a-z0-9+#]+)/i);
            return (m && LANGUAGES[m[1].toLowerCase()]) || "plain text";
        }

        function codeBlock(pre) {
            var code = readability.preformattedText(pre);
            if (!code) { return null; }
            var items = [];
            for (var p = 0; p < code.length && items.length < ITEMS_MAX; p += TEXT_MAX) {
                items.push(text(code.slice(p, p + TEXT_MAX)));
            }
            return {object: "block", type: "code", code: {rich_text: items, language: language(pre)}};
        }

        function listItems(list, depth) {
            var type = list.tagName === "OL" ? "numbered_list_item" : "bulleted_list_item";
            var out  = [];
            for (var i = 0; i < list.children.length; i += 1) {
                var li = list.children[i];
                if (li.tagName !== "LI") { continue; }
                /* Inline text of the item, excluding nested lists. */
                var clone = li.cloneNode(true);
                var nested = clone.querySelectorAll("ul, ol");
                for (var k = 0; k < nested.length; k += 1) { nested[k].parentNode.removeChild(nested[k]); }
                var rt = richText(clone);
                var b  = simple(type, rt.length ? rt : [text(" ")]);
                var sub = [];
                if (depth < 1) {
                    for (var c = 0; c < li.children.length; c += 1) {
                        if (li.children[c].tagName === "UL" || li.children[c].tagName === "OL") {
                            sub = sub.concat(listItems(li.children[c], depth + 1));
                        }
                    }
                }
                if (sub.length) { b[type].children = sub; }
                if (rt.length || sub.length) { out.push(b); }
            }
            return out;
        }

        function block(node, out) {
            for (var i = 0; i < node.childNodes.length; i += 1) {
                var n = node.childNodes[i];
                if (n.nodeType === 3) {
                    var loose = n.nodeValue.replace(/\s+/g, " ").trim();
                    if (loose) { out.push(simple("paragraph", pack([text(loose)]))); }
                    continue;
                }
                if (n.nodeType !== 1 || INLINE_SKIP.test(n.tagName)) { continue; }
                var tag = n.tagName, rt;

                if (/^H[1-6]$/.test(tag)) {
                    rt = richText(n);
                    if (hasText(rt)) { out.push(simple("heading_" + Math.min(3, parseInt(tag[1], 10)), rt)); }
                }
                else if (tag === "P" || tag === "PICTURE" || tag === "A") {
                    /* Images nested in inline-ish wrappers (Medium's <picture>,
                       linked images) would otherwise vanish: inline() skips IMG. */
                    images(n, out);
                    rt = richText(n);
                    if (hasText(rt)) { out.push(simple("paragraph", rt)); }
                }
                else if (tag === "PRE") { var cb = codeBlock(n); if (cb) { out.push(cb); } }
                else if (tag === "BLOCKQUOTE") {
                    var inner = []; block(n, inner);
                    var quoteRT = [];
                    inner.forEach(function (b, idx) {
                        var t = b[b.type] && b[b.type].rich_text;
                        if (!t) { return; }
                        if (quoteRT.length) { quoteRT.push(text("\n")); }
                        quoteRT = quoteRT.concat(t);
                    });
                    quoteRT = pack(quoteRT);
                    if (hasText(quoteRT)) { out.push(simple("quote", quoteRT)); }
                }
                else if (tag === "UL" || tag === "OL") { out.push.apply(out, listItems(n, 0)); }
                else if (tag === "FIGURE") {
                    var cap  = n.getElementsByTagName("figcaption")[0];
                    var capRT = cap ? richText(cap, {italic: true}) : [];
                    var ims  = n.getElementsByTagName("img");
                    var any  = false;
                    for (var k = 0; k < ims.length; k += 1) {
                        var fb = imageBlock(ims[k], k === 0 ? capRT : null);
                        if (fb) { out.push(fb); any = true; }
                    }
                    if (!any && hasText(capRT)) { out.push(simple("paragraph", capRT)); }
                }
                else if (tag === "IMG") { var sb = imageBlock(n); if (sb) { out.push(sb); } }
                else if (tag === "HR")  { out.push({object: "block", type: "divider", divider: {}}); }
                else if (tag === "TABLE" || tag === "DIV" || tag === "SECTION" ||
                         tag === "ARTICLE" || tag === "MAIN" || tag === "SPAN" ||
                         tag === "HEADER" || tag === "FOOTER" || tag === "ASIDE" ||
                         tag === "TBODY" || tag === "TR" || tag === "TD" || tag === "TH") {
                    block(n, out);
                }
                else {
                    images(n, out);
                    rt = richText(n);
                    if (hasText(rt)) { out.push(simple("paragraph", rt)); }
                }
            }
            return out;
        }

        var blocks = [];
        var here   = safeURL(window.location.href);
        blocks.push(simple("paragraph", [
            text("Source: ", {italic: true}),
            text(window.location.hostname || window.location.href, {italic: true}, here)
        ]));
        block(root, blocks);
        return blocks;
    },

    /**
     * Hand the article to the service worker, which holds the Notion token
     * and talks to the API. The content script cannot: no host permission and
     * Notion sends no CORS headers.
     *
     * @return void
    **/
    /* Lucide glyphs, the icon set shadcn/ui ships with. Markup only. */
    ICONS: {
        send:     '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
        copy:     '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        printer:  '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
        rotate:   '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        loader:   '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
        check:    '<path d="M20 6 9 17l-5-5"/>',
        alert:    '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
        external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        x:        '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
        moon:     '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        auto:     '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'
    },

    /**
     * @param String name from ICONS
     * @param String extra classes ("spin", "pop")
     * @return SVGElement
    **/
    icon: function (name, extra) {
        var host = document.createElement("span");
        host.innerHTML = '<svg class="lr-icon ' + (extra || "") + '" viewBox="0 0 24 24" aria-hidden="true">' +
                         (readability.ICONS[name] || "") + "</svg>";
        return host.firstChild;
    },

    /**
     * Focus a control and show it, because a programmatic focus does not
     * satisfy :focus-visible - the ring would be invisible and the
     * preselection would be a secret.
     *
     * @param Element
     * @return void
    **/
    /* "auto" follows the operating system; the other two override it. */
    THEMES: ["auto", "light", "dark"],
    theme:  "auto",

    systemPrefersDark: function () {
        return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    },

    /**
     * Put the chosen theme on <html>, where the stylesheet reads it.
     * Chosen in the extension's options, not here.
     *
     * @param String "auto" | "light" | "dark"
     * @return void
    **/
    applyTheme: function (theme) {
        if (readability.THEMES.indexOf(theme) < 0) { theme = "auto"; }
        readability.theme = theme;
        document.documentElement.setAttribute("data-lr-theme",
            theme === "auto" ? (readability.systemPrefersDark() ? "dark" : "light") : theme);
    },

    /** Read the stored choice, apply it, and keep following the system. */
    initTheme: function () {
        function follow() {
            if (!window.matchMedia) { return; }
            var mq = window.matchMedia("(prefers-color-scheme: dark)");
            var onChange = function () { if (readability.theme === "auto") { readability.applyTheme("auto"); } };
            if (mq.addEventListener) { mq.addEventListener("change", onChange); }
            else if (mq.addListener) { mq.addListener(onChange); }
        }

        readability.applyTheme("auto");
        follow();

        if (window.chrome && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.get({lrTheme: "auto"}, function (items) {
                readability.applyTheme(items && items.lrTheme);
            });
            /* Changing it in the options should reach pages already open. */
            if (chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    if (area === "sync" && changes.lrTheme) {
                        readability.applyTheme(changes.lrTheme.newValue);
                    }
                });
            }
        }
    },

    /**
     * Mark the button whose panel occupies the status row, or clear it.
     * There is one row, so at most one button can be open - which is what
     * makes the filled treatment unambiguous.
     *
     * @param String|null id of the trigger
     * @return void
    **/
    /* How long a finished save stays on screen. Long, on purpose: the reader
       is usually back in the article by the time the save lands, and a line
       that has gone by the time they look up is the same as no line at all.
       Any next action clears it early. */
    DONE_MS: 45000,

    openPanel: function (id) {
        var bar = document.getElementById("readTools");
        if (!bar) { return; }
        var buttons = bar.querySelectorAll("a");
        for (var i = 0; i < buttons.length; i += 1) {
            buttons[i].classList.toggle("open", !!id && buttons[i].id === id);
        }
    },

    // Astra: keep the feedback at its owner's inline edge. Once the controls
    // wrap, a shared full-width row is more honest than an arrow at another button.
    alignRow: function (bar) {
        // Optional element also lets the preview render several independent bars.
        if (!bar || bar.id !== "readTools") { bar = document.getElementById("readTools"); }
        if (!bar) { return; }
        var status = bar.querySelector("#readMarkdownStatus");
        if (!status) { return; }
        var controls = bar.firstElementChild;
        var buttons = controls ? controls.querySelectorAll("a") : [];
        var owner = status._owner && bar.querySelector("#" + status._owner);
        var wrapped = false;
        var top = buttons.length ? buttons[0].getBoundingClientRect().top : 0;
        for (var i = 1; i < buttons.length; i += 1) {
            if (Math.abs(buttons[i].getBoundingClientRect().top - top) > 2) { wrapped = true; }
        }
        var anchor = 0;
        if (owner && !wrapped && status.textContent.trim()) {
            var rowRect = status.getBoundingClientRect();
            var ownerRect = owner.getBoundingClientRect();
            var rtl = window.getComputedStyle(status).direction === "rtl";
            anchor = Math.max(0, rtl ? rowRect.right - ownerRect.right : ownerRect.left - rowRect.left);
            // Never compress a result into a thin sliver at the card's edge.
            if (rowRect.width - anchor < Math.min(240, rowRect.width)) { anchor = 0; }
        }
        bar.classList.toggle("lr-feedback-wide", wrapped || (!anchor && owner &&
            controls && owner !== buttons[0]));
        status.style.setProperty("--lr-row-anchor", anchor + "px");
    },

    // Astra: shared row lifecycle; timers never steal focus from the article.
    isEditingKey: function (e) {
        var t = e.target;
        return !!(e.defaultPrevented || (t && ((t.closest && t.closest("#readTools")) ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)));
    },

    // Astra: a new interaction or dismissal retires all older UI callbacks.
    rowGeneration: 0,

    beginRow: function () {
        readability.rowGeneration += 1;
        return readability.rowGeneration;
    },

    rowIsCurrent: function (generation) {
        return generation === readability.rowGeneration;
    },

    writeRow: function (owner, nodes, ms, kind, generation) {
        if (generation !== undefined && !readability.rowIsCurrent(generation)) { return; }
        var status = document.getElementById("readMarkdownStatus");
        if (!status) { return; }
        window.clearTimeout(status._timer);
        var lostFocus = status.contains(document.activeElement) ||
            (readability.armed && status.contains(readability.armed));
        // Keep boolean success callers compatible; all other states are explicit.
        kind = kind === true ? "done" : kind;
        if (kind !== "done" && kind !== "busy" && kind !== "error") { kind = ""; }
        status.className = "lr-row" + (kind ? " is-" + kind : "");
        status.textContent = "";
        if (kind === "busy" || kind === "error") {
            status.appendChild(readability.icon(kind === "busy" ? "loader" : "alert",
                                               kind === "busy" ? "spin" : ""));
        }
        nodes.forEach(function (node) {
            status.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
        });
        status._owner = owner;
        readability.openPanel(owner);
        readability.alignRow();
        if (lostFocus) { readability.arm(document.getElementById(owner)); }
        var current = readability.rowGeneration;
        if (ms) { status._timer = window.setTimeout(function () {
            if (readability.rowIsCurrent(current)) { readability.closeRow(false); }
        }, ms); }
    },

    closeRow: function (restoreFocus) {
        readability.beginRow();
        var status = document.getElementById("readMarkdownStatus");
        if (!status) { return; }
        var owner = status._owner;
        var lostFocus = status.contains(document.activeElement) ||
            (readability.armed && status.contains(readability.armed));
        window.clearTimeout(status._timer);
        status.className = "lr-row";
        status.textContent = "";
        status._owner = null;
        readability.openPanel(null);
        readability.alignRow();
        if (restoreFocus || lostFocus) { readability.arm(document.getElementById(owner)); }
    },

    armed: null,

    /**
     * Focus a control and show it, because a programmatic focus does not
     * satisfy :focus-visible - the ring would be invisible and the
     * preselection would be a secret.
     *
     * Deliberately NOT undone by blur. Activating the extension from the
     * toolbar or by shortcut leaves keyboard focus in the browser's own UI,
     * which blurs the page's focused element immediately; undoing the ring
     * there wiped the preselection before the reader ever saw it. It is
     * undone only when the reader focuses or clicks something else.
     *
     * @param Element
     * @return void
    **/
    arm: function (el) {
        if (!el) { return; }

        if (readability.armed && readability.armed !== el) {
            readability.armed.classList.remove("armed");
        }
        readability.armed = el;
        el.classList.add("armed");

        try { window.focus(); } catch (e) { /* not allowed everywhere */ }
        try { el.focus({preventScroll: true}); } catch (e) { el.focus(); }

        if (!readability.armWatching) {
            readability.armWatching = true;

            function disarm() {
                if (!readability.armed) { return; }
                readability.armed.classList.remove("armed");
                readability.armed = null;
            }

            /* The reader moved focus themselves. */
            document.addEventListener("focusin", function (e) {
                if (readability.armed && e.target !== readability.armed) { disarm(); }
            });
            /* Or pressed somewhere else. */
            document.addEventListener("mousedown", function (e) {
                if (readability.armed && e.target !== readability.armed &&
                    !readability.armed.contains(e.target)) { disarm(); }
            }, true);
            /* Coming back to the page: take the focus back, so Enter works,
               unless something else now holds it. */
            window.addEventListener("focus", function () {
                var a = readability.armed;
                if (!a) { return; }
                var cur = document.activeElement;
                if (!cur || cur === document.body || cur === document.documentElement || cur === a) {
                    try { a.focus({preventScroll: true}); } catch (e) { a.focus(); }
                }
            });
        }

        /* Pages routinely move focus a moment after the reader is built. */
        window.setTimeout(function () {
            var a = readability.armed;
            if (a !== el) { return; }
            var cur = document.activeElement;
            if (!cur || cur === document.body || cur === document.documentElement) {
                el.classList.add("armed");
                try { el.focus({preventScroll: true}); } catch (e) { el.focus(); }
            }
        }, 350);
    },

    /**
     * One way to talk to the service worker, with every failure turned into a
     * response object so callers never have to think about lastError.
    **/
    notionMessage: function (msg, cb) {
        if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
            cb({ok: false, code: "noext", error: "Notion export needs the extension - use Copy as Markdown"});
            return;
        }
        try {
            chrome.runtime.sendMessage(msg, function (resp) {
                if (chrome.runtime.lastError) {
                    var why  = chrome.runtime.lastError.message || "";
                    var hint = /port closed|Receiving end/i.test(why)
                        ? " - the extension's background script is out of date: reload the extension, then this page"
                        : /context invalidated/i.test(why)
                        ? " - the extension was reloaded under this page: reload the page"
                        : " - reload the page and try again";
                    cb({ok: false, code: "noanswer", error: "No answer from the extension (" + why + ")" + hint});
                } else {
                    cb(resp || {ok: false, code: "noanswer", error: "Empty reply from the extension"});
                }
            });
        } catch (e) {
            cb({ok: false, code: "noext", error: "Notion export needs the extension - use Copy as Markdown"});
        }
    },

    /**
     * Intent, not action: hovering or focusing "Send to Notion" is a signal
     * that it is about to be pressed, so the destinations are fetched then.
     * By the time the click lands the chooser can open with no wait, and a
     * missing connection is already known.
    **/
    notionPrefetch: function () {
        var c = readability.notionCache;
        if (readability.notionPending || (c && Date.now() - c.at < 60000)) { return; }
        readability.notionPending = true;
        readability.notionMessage({type: "notion-targets"}, function (resp) {
            readability.notionPending = false;
            readability.notionCache   = {at: Date.now(), resp: resp};
        });
    },

    notionCache:   null,
    notionPending: false,

    sendToNotion: function () {
        var content = document.getElementById("readability-content");
        var status  = document.getElementById("readMarkdownStatus");
        if (!content || !status) { return; }
        var generation = readability.beginRow();

        /* Each write replaces the state as well as the content. */
        function show(nodes, ms, kind) {
            readability.writeRow("send-notion", nodes, ms, kind, generation);
        }
        function link(label, href, onclick, cls) {
            var a = document.createElement("a");
            a.textContent = label; a.href = href || "#";
            if (!href) { a.setAttribute("role", "button"); }
            if (cls)  { a.className = cls; }
            if (href) { a.target = "_blank"; a.rel = "noopener"; }
            if (onclick) { a.addEventListener("click", function (e) { e.preventDefault(); onclick(); }); }
            return a;
        }
        function openOptions(section) {
            request({type: "open-options", at: section || "notion"}, function () {});
        }

        /* Ask the service worker; normalise every failure into {ok:false, error, code}. */
        function request(msg, cb) {
            var receive = cb;
            cb = function (resp) {
                if (readability.rowIsCurrent(generation)) { receive(resp); }
            };
            if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
                cb({ok: false, code: "noext", error: "Notion export needs the extension - use Copy as Markdown"});
                return;
            }
            try {
                chrome.runtime.sendMessage(msg, function (resp) {
                    if (chrome.runtime.lastError) {
                        /* "Extension context invalidated": the extension was reloaded under this
                           page - reload the page. "Receiving end does not exist": stale worker. */
                        var why  = chrome.runtime.lastError.message || "";
                        var hint = /port closed|Receiving end/i.test(why)
                            ? " - the extension's background script is out of date: reload the extension on the extensions page, then reload this page"
                            : /context invalidated/i.test(why)
                            ? " - the extension was reloaded under this page: reload the page"
                            : " - reload the page and try again";
                        cb({ok: false, code: "noanswer", error: "Notion: no answer from the extension (" + why + ")" + hint});
                    } else {
                        cb(resp || {ok: false, code: "noanswer", error: "Notion: empty reply from the extension"});
                    }
                });
            } catch (e) {
                cb({ok: false, code: "noext", error: "Notion export needs the extension - use Copy as Markdown"});
            }
        }

        function fail(resp) {
            if (resp.code === "not-connected" || resp.code === "no-target" ||
                resp.code === "no-permission" || resp.code === "unknown") {
                /* "unknown" means a stale background script; opening the options
                   page repairs it, because that page checks and reloads. */
                show([resp.error + " ", link("open options", null, function () {
                    openOptions(resp.code === "no-target" ? "destinations" : "notion");
                })], 0, "error");
            } else {
                show([resp.error], 0, "error");
            }
        }

        /* Step 2: the chooser. Asked on every send; the options page only preselects. */
        function choose(resp) {
            var byTarget = resp.tagsByTarget || {};
            var options  = [];   /* tag names already in the chosen database */
            var active   = -1;   /* highlighted suggestion */

            /* ---- destination ---- */
            var sel = document.createElement("select");
            /* "(db)" only tells databases from pages; with databases alone it is noise. */
            var mixed = resp.targets.some(function (x) { return x.type !== "database"; }) &&
                        resp.targets.some(function (x) { return x.type === "database"; });
            for (var i = 0; i < resp.targets.length; i += 1) {
                var t   = resp.targets[i];
                var opt = document.createElement("option");
                opt.value = t.id;
                opt.textContent = (t.icon ? t.icon + " " : "") + t.title + (mixed && t.type === "database" ? " (db)" : "");
                opt.setAttribute("data-type", t.type);
                if (t.id === resp.defaultId) { opt.selected = true; }
                sel.appendChild(opt);
            }

            /* ---- tags: type-ahead over the database's existing tag names ---- */
            var box = document.createElement("span");
            box.className = "lr-tagbox";

            var tags = document.createElement("input");
            tags.type         = "text";
            tags.id           = "readNotionTags";
            tags.placeholder  = "tags, comma separated";
            tags.title        = "Written to the database's tag property. Databases only.";
            tags.autocomplete = "off";
            tags.setAttribute("role", "combobox");
            tags.setAttribute("aria-autocomplete", "list");
            tags.setAttribute("aria-expanded", "false");
            tags.setAttribute("aria-controls", "readNotionTagList");

            var menu = document.createElement("ul");
            menu.className = "lr-suggest";
            menu.id        = "readNotionTagList";
            menu.setAttribute("role", "listbox");
            /* Chrome makes a scrollable box keyboard-focusable, which would put
               the suggestion list itself into the tab order between the field
               and Save here. Options are reached with the arrow keys instead. */
            menu.tabIndex  = -1;
            menu.hidden    = true;

            box.appendChild(tags);
            box.appendChild(menu);

            /* The field holds a comma-separated list, so completion applies to the
               segment after the last comma; everything already entered stays. */
            function parts()    { return tags.value.split(","); }
            function term()     { var p = parts(); return p[p.length - 1].trim(); }
            function entered()  {
                return parts().slice(0, -1).map(function (t) { return t.trim().toLowerCase(); })
                              .filter(function (t) { return t.length > 0; });
            }

            function matches() {
                var q     = term().toLowerCase();
                var taken = entered();
                var pool  = options.filter(function (o) { return taken.indexOf(o.toLowerCase()) < 0; });
                if (!q) { return pool.slice(0, 8); }
                var starts = [], contains = [];
                pool.forEach(function (o) {
                    var at = o.toLowerCase().indexOf(q);
                    if (at === 0) { starts.push(o); } else if (at > 0) { contains.push(o); }
                });
                return starts.concat(contains).slice(0, 8);
            }

            function render() {
                var list = matches();
                menu.innerHTML = "";
                if (tags.hidden || !list.length || document.activeElement !== tags) {
                    menu.hidden = true;
                    tags.setAttribute("aria-expanded", "false");
                    tags.removeAttribute("aria-activedescendant");
                    return;
                }
                if (active >= list.length) { active = list.length - 1; }
                list.forEach(function (name, i) {
                    var li = document.createElement("li");
                    li.textContent = name;
                    li.id = "readNotionTagOpt" + i;
                    li.setAttribute("role", "option");
                    li.setAttribute("aria-selected", i === active ? "true" : "false");
                    if (i === active) { li.className = "on"; }
                    /* mousedown, not click: blur would close the menu first. */
                    li.addEventListener("mousedown", function (e) { e.preventDefault(); accept(name); });
                    menu.appendChild(li);
                });
                menu.hidden = false;
                tags.setAttribute("aria-expanded", "true");
                if (active >= 0) { tags.setAttribute("aria-activedescendant", "readNotionTagOpt" + active); }
                else { tags.removeAttribute("aria-activedescendant"); }
            }

            /* Complete the segment being typed and leave it standing. */
            function accept(name) {
                var p = parts();
                p[p.length - 1] = (p.length > 1 ? " " : "") + name;
                tags.value  = p.join(",");
                active      = -1;
                menu.hidden = true;
                tags.setAttribute("aria-expanded", "false");
                tags.removeAttribute("aria-activedescendant");
                tags.focus();
            }

            function commit() {
                var o = sel.options[sel.selectedIndex];
                if (!o) { return; }
                send({id: o.value, type: o.getAttribute("data-type"), title: o.textContent},
                     tags.hidden ? "" : tags.value);
            }

            function reveal() {
                var li = menu.children[active];
                if (!li) { return; }
                if (li.offsetTop < menu.scrollTop) { menu.scrollTop = li.offsetTop; }
                else if (li.offsetTop + li.offsetHeight > menu.scrollTop + menu.clientHeight) {
                    menu.scrollTop = li.offsetTop + li.offsetHeight - menu.clientHeight;
                }
            }

            tags.addEventListener("input", function () { active = 0; render(); });
            tags.addEventListener("focus", function () { active = -1; render(); });
            tags.addEventListener("blur",  function () {
                window.setTimeout(function () { menu.hidden = true; }, 150);
            });
            tags.addEventListener("keydown", function (e) {
                var list = matches();
                var open = !menu.hidden && list.length > 0;
                if (e.key === "ArrowDown") {
                    active = open ? Math.min(active + 1, list.length - 1) : 0;
                    render(); reveal(); e.preventDefault();
                } else if (e.key === "ArrowUp") {
                    active = Math.max(active - 1, 0); render(); reveal(); e.preventDefault();
                } else if (e.key === "Escape") {
                    /* Only swallow Escape while the menu is actually open.
                       Swallowing it unconditionally meant Escape could never
                       reach the bar to close the chooser, or the reader. */
                    if (open) {
                        menu.hidden = true;
                        tags.setAttribute("aria-expanded", "false");
                        tags.removeAttribute("aria-activedescendant");
                        e.preventDefault();
                    }
                } else if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) &&
                           open && active >= 0 && list[active]) {
                    /* Shift+Tab is "go back", never "accept". */
                    accept(list[active]); e.preventDefault();
                } else if (e.key === "Enter") {
                    commit(); e.preventDefault();
                }
            });

            function loadOptions(targetId) {
                options = [];
                render();
                tags.placeholder = "loading tags…";
                request({type: "notion-tag-options", targetId: targetId}, function (r) {
                    var o = sel.options[sel.selectedIndex];
                    if (!o || o.value !== targetId) { return; }
                    if (!r.ok) {
                        /* Silence here was the whole of "tags do not fill". */
                        tags.placeholder = r.code === "unknown" ? "tags (extension out of date)"
                                                                : "tags (list unavailable)";
                        tags.title = r.error;
                        return;
                    }
                    options = r.options || [];
                    tags.placeholder = r.property
                        ? r.property.toLowerCase() + (options.length ? ", type to search" : ", comma separated")
                        : "tags, comma separated";
                    render();
                });
            }

            function label(txt) {
                var s = document.createElement("span");
                s.className = "lr-label";
                s.textContent = txt;
                return s;
            }
            var toLabel  = label("to:");
            var tagLabel = label("Tag:");

            /* Tags land in a database property; a plain page has none. */
            function syncTags() {
                var o    = sel.options[sel.selectedIndex];
                var isDb = o && o.getAttribute("data-type") === "database";
                box.hidden      = !isDb;
                tags.hidden     = !isDb;
                tagLabel.hidden = !isDb;
                menu.hidden     = true;
                if (isDb) { tags.value = byTarget[o.value] || ""; loadOptions(o.value); }
            }
            sel.addEventListener("change", syncTags);
            syncTags();

            /* Save leads the row, in both panels. It used to sit second from
               the right, which put the button that commits diagonally across
               the card from the button that opened the panel - press top left,
               then travel to bottom right. Leading also lets the row read as
               one sentence: Save - to: - <destination>. */
            var save = link("Save", null, commit, "primary");
            show([save, toLabel, sel, tagLabel, box,
                  link("refresh list", null, function () { ask(true); }),
                  link("cancel", null, function () { readability.closeRow(true); })]);
            /* Enter again saves to the remembered destination. Tab from here
               reaches the destination and the tag field for anyone who wants
               to change them. */
            readability.arm(save);
        }

        /* Step 1: destinations the user granted during sign-in. */
        function ask(refresh) {
            /* Warmed by the hover/focus prefetch, so this usually costs nothing. */
            var warm = readability.notionCache;
            if (!refresh && warm && Date.now() - warm.at < 60000 && warm.resp && warm.resp.ok) {
                received(warm.resp);
                return;
            }
            show([refresh ? "Refreshing Notion destinations…" : "Loading Notion destinations…"], 0, "busy");
            request({type: "notion-targets", refresh: !!refresh}, function (resp) {
                if (resp && resp.ok) { readability.notionCache = {at: Date.now(), resp: resp}; }
                received(resp);
            });

            function received(resp) {
                if (!resp.ok) { fail(resp); return; }
                if (!resp.targets || !resp.targets.length) {
                    show(["No Notion pages shared with the extension yet ",
                          link("refresh list", null, function () { ask(true); }),
                          link("options", null, openOptions)], 0, "error");
                    return;
                }
                choose(resp);
            }
        }

        /* Step 3: send. */
        function send(target, tagText) {
            show(["Sending to Notion…"], 0, "busy");
            var h1    = document.querySelector("#readOverlay h1, #readInner h1");
            var title = ((h1 ? h1.textContent : document.title) || "Untitled").trim();
            var tagList = (tagText || "").split(",").map(function (t) { return t.trim(); })
                             .filter(function (t) { return t.length > 0 && t.length <= 100; });
            var article = {title: title, url: window.location.href, tags: tagList,
                           blocks: readability.toNotionBlocks(content)};
            request({type: "notion-send", article: article, target: target, tagText: tagText || ""},
                    function (resp) {
                if (resp.ok) {
                    var note = resp.tagProperty ? " (tags → " + resp.tagProperty : "";
                    if (note && resp.createdTags && resp.createdTags.length) {
                        note += ", " + resp.createdTags.length + " new";
                    }
                    if (note) { note += ")"; }
                    show(["Saved to Notion" + note + " ", link("open it", resp.url)],
                         readability.DONE_MS, true);
                } else { fail(resp); }
            });
        }

        ask(false);
    },

    /**
     * Serialise the extracted article as Markdown.
     *
     * Walks the reassembled content rather than the original page, so what is
     * written out is exactly what the reader sees.
     *
     * @param Element
     * @return String
    **/
    toMarkdown: function (root, rewrite) {
        var INLINE_SKIP = /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|SVG|BUTTON|INPUT|SELECT|TEXTAREA)$/;

        function esc(text) {
            return text.replace(/([\\`*_\[\]])/g, "\\$1");
        }

        function inline(node) {
            var out = "";

            for (var i = 0; i < node.childNodes.length; i += 1) {
                var n = node.childNodes[i];

                if (n.nodeType === 3) {
                    out += esc(n.nodeValue.replace(/\s+/g, " "));
                    continue;
                }
                if (n.nodeType !== 1 || INLINE_SKIP.test(n.tagName)) { continue; }

                var tag = n.tagName;

                if (tag === "BR") { out += "  \n"; }
                else if (tag === "IMG") { out += image(n); }
                else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
                    out += "`" + n.textContent.replace(/\s+/g, " ") + "`";
                }
                else if (tag === "STRONG" || tag === "B") {
                    var b = inline(n).trim();
                    out += b ? "**" + b + "**" : "";
                }
                else if (tag === "EM" || tag === "I") {
                    var it = inline(n).trim();
                    out += it ? "*" + it + "*" : "";
                }
                else if (tag === "A") {
                    var label = inline(n).trim();
                    var href  = n.getAttribute("href") || "";
                    out += (label && href) ? "[" + label + "](" + href + ")" : label;
                }
                else { out += inline(n); }
            }

            return out;
        }

        function image(n) {
            var src = n.getAttribute("data-notemill-fullres") ||
                      n.currentSrc || n.getAttribute("src") || "";
            if (!src) { return ""; }
            var url = readability.fullResImageURL(src);
            var alt = (n.getAttribute("alt") || "").replace(/[\[\]]/g, "");
            /* When saving a folder, point at the copy next to the file. */
            if (rewrite) { url = rewrite(url) || url; }
            return "![" + alt + "](" + url + ")";
        }

        function block(node, depth) {
            var out = [];

            for (var i = 0; i < node.childNodes.length; i += 1) {
                var n = node.childNodes[i];

                if (n.nodeType === 3) {
                    var loose = n.nodeValue.replace(/\s+/g, " ").trim();
                    if (loose) { out.push(esc(loose)); }
                    continue;
                }
                if (n.nodeType !== 1 || INLINE_SKIP.test(n.tagName)) { continue; }

                var tag  = n.tagName;
                var text = "";

                if (/^H[1-6]$/.test(tag)) {
                    text = inline(n).trim();
                    if (text) { out.push(new Array(parseInt(tag[1], 10) + 1).join("#") + " " + text); }
                }
                else if (tag === "P") {
                    text = inline(n).trim();
                    if (text) { out.push(text); }
                }
                else if (tag === "PRE") {
                    var code = readability.preformattedText(n);
                    var cls  = (n.className || "") + " " +
                               ((n.firstElementChild && n.firstElementChild.className) || "");
                    var lang = (cls.match(/(?:language|lang)-([a-z0-9+#]+)/i) || ["", ""])[1];
                    if (code) { out.push("```" + lang + "\n" + code + "\n```"); }
                }
                else if (tag === "BLOCKQUOTE") {
                    var inner = block(n, depth).split("\n").map(function (line) {
                        return line ? "> " + line : ">";
                    }).join("\n");
                    if (inner.replace(/[>\s]/g, "")) { out.push(inner); }
                }
                else if (tag === "UL" || tag === "OL") {
                    var items = [];
                    var num   = 1;
                    for (var li = 0; li < n.children.length; li += 1) {
                        if (n.children[li].tagName !== "LI") { continue; }
                        var marker = (tag === "OL") ? (num += 1, (num - 1) + ". ") : "- ";
                        /* Only recurse for items that really contain blocks; otherwise
                           inline markup inside the item would be split into
                           separate paragraphs. */
                        var hasBlock = n.children[li].querySelector(
                            "p, div, pre, ul, ol, blockquote, figure, table");
                        var body   = hasBlock ? block(n.children[li], depth + 1).trim()
                                              : inline(n.children[li]).trim();
                        if (!body) { continue; }
                        var pad = new Array(marker.length + 1).join(" ");
                        items.push(marker + body.split("\n").join("\n" + pad));
                    }
                    if (items.length) { out.push(items.join("\n")); }
                }
                else if (tag === "FIGURE") {
                    var pic = [];
                    var ims = n.getElementsByTagName("img");
                    for (var k = 0; k < ims.length; k += 1) { pic.push(image(ims[k])); }
                    var cap = n.getElementsByTagName("figcaption")[0];
                    if (pic.length) { out.push(pic.join("\n")); }
                    if (cap) {
                        var ct = inline(cap).trim();
                        if (ct) { out.push("*" + ct + "*"); }
                    }
                }
                else if (tag === "IMG") { text = image(n); if (text) { out.push(text); } }
                else if (tag === "HR")  { out.push("---"); }
                else if (tag === "TABLE" || tag === "DIV" || tag === "SECTION" ||
                         tag === "ARTICLE" || tag === "MAIN" || tag === "SPAN" ||
                         tag === "HEADER" || tag === "FOOTER" || tag === "ASIDE") {
                    var nested = block(n, depth);
                    if (nested.trim()) { out.push(nested); }
                }
                else {
                    text = inline(n).trim();
                    if (text) { out.push(text); }
                }
            }

            return out.join("\n\n");
        }

        var title = "";
        var h1    = document.querySelector("#readOverlay h1, #readInner h1");
        if (h1) { title = h1.textContent.trim(); }

        var body = block(root, 0)
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]+\n/g, "\n")
            .trim();

        var head = [];
        if (title) { head.push("# " + title); }
        head.push("*Source: [" + window.location.hostname + "](" + window.location.href + ")*");

        return head.join("\n\n") + "\n\n" + body + "\n";
    },

    /**
     * A filename Chromium will accept, and a human can read.
     *
     * @param String
     * @param String fallback
     * @return String
    **/
    safeName: function (text, fallback) {
        var s = (text || "").trim().toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 80);
        return s || fallback;
    },

    /**
     * Every distinct image in the article, with the path it will occupy
     * inside the saved folder.
     *
     * The extension is taken from the URL where there is one. Medium and
     * friends often serve extensionless URLs, and neither this page nor the
     * service worker may fetch them to ask (no host permission, and CORS),
     * so those fall back to .jpg. The link and the file always agree, so the
     * document is correct either way; only the icon may be wrong.
     *
     * @param Element
     * @return Object {list: [{url, path}], map: {url: path}}
    **/
    collectImages: function (root) {
        var imgs = root.getElementsByTagName("img");
        var list = [], map = {}, n = 0;

        for (var i = 0; i < imgs.length; i += 1) {
            var raw = imgs[i].getAttribute("data-notemill-fullres") ||
                      imgs[i].currentSrc || imgs[i].getAttribute("src") || "";
            var url = readability.fullResImageURL(raw);
            if (!url || map[url]) { continue; }
            if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) { continue; }

            var ext = (url.match(/\.(png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i) || [])[1];
            if (!ext) {
                var mime = url.match(/^data:image\/([a-z0-9.+-]+)/i);
                if (mime) { ext = mime[1]; }
            }
            ext = (ext || "jpg").toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");

            var base = "";
            if (/^https?:/i.test(url)) {
                try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); }
                catch (e) { base = ""; }
            }
            base = readability.safeName(base.replace(/\.[a-z0-9]+$/i, ""), "image");

            n += 1;
            var path = "images/" + ("0" + n).slice(-2) + "-" + base + "." + ext;
            map[url] = path;
            list.push({url: url, path: path});
        }

        return {list: list, map: map};
    },

    /**
     * Ask where to save, then save. The row mirrors the Notion chooser: the
     * remembered folder, a way to change it, and one primary action.
     *
     * @param Element  the reassembled article
     * @param Object   {list, map} from collectImages
     * @param String   slug for the article's own subfolder
     * @param Function status writer
     * @return void
    **/
    chooseSaveFolder: function (content, pack, name, say, generation) {
        if (generation === undefined) { generation = readability.beginRow(); }
        var status = document.getElementById("readMarkdownStatus");
        if (!status) { return; }

        function show(nodes, ms, kind) {
            readability.writeRow("save-markdown", nodes, ms, kind, generation);
        }

        function button(label, onclick, cls) {
            var a = document.createElement("a");
            a.href = "#";
            a.textContent = label;
            a.setAttribute("role", "button");
            if (cls) { a.className = cls; }
            a.addEventListener("click", function (e) { e.preventDefault(); onclick(); });
            return a;
        }

        function label(text) {
            var s = document.createElement("span");
            s.className = "lr-label";
            s.textContent = text;
            return s;
        }

        /* Write it. The destination decides who reads the pictures: through the
           downloads API the browser fetches them from their URLs, but into a
           folder we write ourselves the bytes have to come from this page -
           the worker has no host permission for image CDNs. */
        function save(folder) {
            var bundled = readability.toMarkdown(content, function (url) { return pack.map[url]; });

            function deliver(images) {
                // A committed save continues, but its stale UI stays dismissed.
                show([folder ? "saving into " + folder + "…" : "saving…"], 0, "busy");
                readability.notionMessage({type: "save-bundle", folder: name,
                                           markdown: bundled, images: images}, function (resp) {
                    if (resp && resp.ok) {
                        show(["saved " + resp.saved + " file" + (resp.saved === 1 ? "" : "s") +
                              " to " + name + (resp.into ? " in " + resp.into : " in Downloads") +
                              (resp.failed ? " (" + resp.failed + " image" +
                                             (resp.failed === 1 ? "" : "s") + " could not be read)" : "")],
                             readability.DONE_MS, true);
                    } else {
                        show([(resp && resp.error) || "could not save"], 0, "error");
                    }
                });
            }

            if (!folder || !pack.list.length) { deliver(pack.list); return; }
            show(["reading " + pack.list.length + " image" + (pack.list.length === 1 ? "" : "s") + "…"], 0, "busy");
            readability.fetchImageBytes(pack.list, deliver);
        }

        function offer(folder) {
            if (!readability.rowIsCurrent(generation)) { return; }
            /* "to:", not "Save to:": the Save button now sits immediately to
               its left and would say the word twice. */
            var where = label("to:");
            var value = label(folder || "Downloads folder");
            value.className = "lr-value";
            var go = button("Save", function () { save(folder); }, "primary");
            show([go, where, value,
                  button(folder ? "change folder…" : "choose folder…", pick),
                  button("cancel", function () {
                      readability.closeRow(true);
                  })]);
            readability.arm(go);
        }

        function pick() {
            show(["waiting for the folder you choose…"], 0, "busy");
            readability.notionMessage({type: "pick-folder"}, function (resp) {
                if (!readability.rowIsCurrent(generation)) { return; }
                if (resp && resp.ok && resp.folder) { offer(resp.folder); return; }
                if (resp && resp.ok && resp.cancelled) {
                    /* Nothing chosen: come back to whatever was remembered. */
                    readability.notionMessage({type: "save-target"}, function (t) {
                        offer(t && t.ok ? t.folder : null);
                    });
                    return;
                }
                show([(resp && resp.error) || "could not open the folder chooser"], 0, "error");
            });
        }

        show(["checking where to save…"], 0, "busy");
        readability.notionMessage({type: "save-target"}, function (target) {
            if (!target || !target.ok) { show([target && target.error ? target.error : "could not reach the extension"], 0, "error"); return; }
            offer(target.folder);
        });
    },

    /**
     * Read each picture and hand back base64 bytes, for saving into a folder
     * the extension writes itself.
     *
     * Anything that cannot be read - a CDN without permissive CORS, an image
     * too large to pass through a message - comes back without bytes, and the
     * worker counts it as a failure rather than losing the document with it.
     *
     * @param Array [{url, path}]
     * @param Function called with [{url, path, data?, type?}]
     * @return void
    **/
    fetchImageBytes: function (list, done) {
        var MAX_ONE   = 8 * 1024 * 1024;
        var MAX_TOTAL = 24 * 1024 * 1024;
        var out = [], total = 0, index = 0;

        function encode(buffer) {
            var bytes = new Uint8Array(buffer);
            var chunk = 0x8000, parts = [];
            for (var i = 0; i < bytes.length; i += chunk) {
                parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
            }
            return window.btoa(parts.join(""));
        }

        function next() {
            if (index >= list.length) { done(out); return; }
            var img = list[index];
            index += 1;

            window.fetch(img.url, {credentials: "omit", cache: "force-cache"})
                .then(function (response) {
                    if (!response.ok) { throw new Error("HTTP " + response.status); }
                    var type = response.headers.get("content-type") || "";
                    return response.arrayBuffer().then(function (buffer) {
                        if (buffer.byteLength > MAX_ONE || total + buffer.byteLength > MAX_TOTAL) {
                            throw new Error("too large");
                        }
                        total += buffer.byteLength;
                        out.push({url: img.url, path: img.path, type: type, data: encode(buffer)});
                    });
                })
                .catch(function () { out.push({url: img.url, path: img.path}); })
                .then(next);
        }

        next();
    },

    /**
     * Hand the Markdown to the user: clipboard first, and always a .md file so
     * there is a copy on disk regardless of clipboard permissions.
     *
     * @param String  "copy" or "save"
     * @return void
    **/
    exportMarkdown: function (how) {
        var content = document.getElementById("readability-content");
        if (!content) { return; }
        var generation = readability.beginRow();

        var md     = readability.toMarkdown(content);
        var status = document.getElementById("readMarkdownStatus");

        /* The row under the bar belongs to whichever button produced it, so
           that button stays lit for as long as the row is up. Copy Markdown
           has no panel to open but it does have a result, and that is the
           same claim: this line came from here. */
        var owner = how === "copy" ? "copy-markdown" : "save-markdown";

        function say(msg, done) {
            if (status) {
                readability.writeRow(owner, [msg], done ? readability.DONE_MS : 0,
                                     done ? "done" : "error", generation);
            }
        }

        if (how === "copy") {
            readability.writeRow(owner, ["Copying Markdown…"], 0, "busy", generation);
            if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
                window.navigator.clipboard.writeText(md).then(function () {
                    say("copied " + md.length + " chars", true);
                }, function () {
                    say("clipboard blocked - use Save .md");
                });
            } else {
                say("clipboard unavailable - use Save .md");
            }
            return;
        }

        var h1   = document.querySelector("#readOverlay h1, #readInner h1");
        var name = readability.safeName((h1 ? h1.textContent : document.title) || "article", "article");

        /* Preferred: a folder holding the document and its pictures, chosen
           here rather than in the settings. Only the service worker can write
           it - chrome.downloads is not exposed to this page, a page download
           cannot create directories, and a folder handle the user picked lives
           in the extension's own storage. */
        var pack = readability.collectImages(content);
        if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
            readability.chooseSaveFolder(content, pack, name, say, generation);
            return;
        }

        var blob = new window.Blob([md], {type: "text/markdown;charset=utf-8"});
        var url  = window.URL.createObjectURL(blob);
        var a    = document.createElement("a");

        a.href     = url;
        a.download = name + ".md";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(function () { window.URL.revokeObjectURL(url); }, 10000);
        say("saved " + name + ".md", true);
    },

    /**
     * Does this element wrap a real content image?
     *
     * Modern CMSs (Medium, Substack, most WordPress themes) put every
     * article image in its own wrapper div with no paragraph in it. The
     * "img > p" rule in cleanConditionally() predates that convention and
     * deletes such wrappers outright, taking the image with them.
     *
     * Size is what separates a content image from page furniture. Prefer the
     * rendered size, because junk thumbnails are often served from a large
     * source but displayed small; fall back to intrinsic/attribute size when
     * the node is not laid out. A <figure> ancestor is treated as an explicit
     * authorial signal regardless of size.
     *
     * @param Element
     * @return boolean
    **/
    hasContentImage: function (e) {
        var imgs = e.getElementsByTagName("img");

        for (var i = 0, il = imgs.length; i < il; i += 1) {
            var img = imgs[i];
            /* Rendered and declared sizes describe how the page actually
               presents the image, so they outrank the intrinsic size: a
               thumbnail rail is often served from a large source but shown
               small. Intrinsic size is the fallback for images that are not
               laid out yet and carry no width/height attributes. */
            var attrW = parseInt(img.getAttribute("width"), 10)  || 0;
            var attrH = parseInt(img.getAttribute("height"), 10) || 0;
            var w     = Math.max(img.offsetWidth  || 0, attrW) || img.naturalWidth  || 0;
            var h     = Math.max(img.offsetHeight || 0, attrH) || img.naturalHeight || 0;

            if (w >= readability.CONTENT_IMAGE_MIN_WIDTH && h >= readability.CONTENT_IMAGE_MIN_HEIGHT) {
                return true;
            }

            for (var node = img.parentNode; node && node !== e.ownerDocument.body; node = node.parentNode) {
                if (node.tagName === "FIGURE") {
                    return true;
                }
            }
        }

        return false;
    },

    cleanConditionally: function (e, tag) {

        if(!readability.flagIsActive(readability.FLAG_CLEAN_CONDITIONALLY)) {
            return;
        }

        var tagsList      = e.getElementsByTagName(tag);
        var curTagsLength = tagsList.length;

        /**
         * Gather counts for other typical elements embedded within.
         * Traverse backwards so we can remove nodes at the same time without effecting the traversal.
         *
         * TODO: Consider taking into account original contentScore here.
        **/
        for (var i=curTagsLength-1; i >= 0; i-=1) {
            var weight = readability.getClassWeight(tagsList[i]);
            var contentScore = (typeof tagsList[i].readability !== 'undefined') ? tagsList[i].readability.contentScore : 0;

            dbg("Cleaning Conditionally " + tagsList[i] + " (" + tagsList[i].className + ":" + tagsList[i].id + ")" + ((typeof tagsList[i].readability !== 'undefined') ? (" with score " + tagsList[i].readability.contentScore) : ''));

            if(weight+contentScore < 0)
            {
                tagsList[i].parentNode.removeChild(tagsList[i]);
            }
            else if ( readability.getCharCount(tagsList[i],',') < 10) {
                /**
                 * If there are not very many commas, and the number of
                 * non-paragraph elements is more than paragraphs or other ominous signs, remove the element.
                **/
                var p      = tagsList[i].getElementsByTagName("p").length;
                var img    = tagsList[i].getElementsByTagName("img").length;
                var li     = tagsList[i].getElementsByTagName("li").length-100;
                var input  = tagsList[i].getElementsByTagName("input").length;

                var embedCount = 0;
                var embeds     = tagsList[i].getElementsByTagName("embed");
                for(var ei=0,il=embeds.length; ei < il; ei+=1) {
                    if (embeds[ei].src.search(readability.regexps.videos) === -1) {
                      embedCount+=1;
                    }
                }

                var linkDensity   = readability.getLinkDensity(tagsList[i]);
                var contentLength = readability.getInnerText(tagsList[i]).length;
                var toRemove      = false;

                if ( img > p && !readability.hasContentImage(tagsList[i]) ) {
                    toRemove = true;
                } else if(li > p && tag !== "ul" && tag !== "ol") {
                    toRemove = true;
                } else if( input > Math.floor(p/3) ) {
                    toRemove = true;
                } else if(contentLength < 25 && (img === 0 || img > 2) ) {
                    toRemove = true;
                } else if(weight < 25 && linkDensity > 0.2) {
                    toRemove = true;
                } else if(weight >= 25 && linkDensity > 0.5) {
                    toRemove = true;
                } else if((embedCount === 1 && contentLength < 75) || embedCount > 1) {
                    toRemove = true;
                }

                if(toRemove) {
                    tagsList[i].parentNode.removeChild(tagsList[i]);
                }
            }
        }
    },

    /**
     * Clean out spurious headers from an Element. Checks things like classnames and link density.
     *
     * @param Element
     * @return void
    **/
    cleanHeaders: function (e) {
        for (var headerIndex = 1; headerIndex < 3; headerIndex+=1) {
            var headers = e.getElementsByTagName('h' + headerIndex);
            for (var i=headers.length-1; i >=0; i-=1) {
                if (readability.getClassWeight(headers[i]) < 0 || readability.getLinkDensity(headers[i]) > 0.33) {
                    headers[i].parentNode.removeChild(headers[i]);
                }
            }
        }
    },

    /*** Smooth scrolling logic ***/

    /**
     * easeInOut animation algorithm - returns an integer that says how far to move at this point in the animation.
     * Borrowed from jQuery's easing library.
     * @return integer
    **/
    easeInOut: function(start,end,totalSteps,actualStep) {
        var delta = end - start;

        if ((actualStep/=totalSteps/2) < 1) {
            return delta/2*actualStep*actualStep + start;
        }
        actualStep -=1;
        return -delta/2 * ((actualStep)*(actualStep-2) - 1) + start;
    },

    /**
     * Helper function to, in a cross compatible way, get or set the current scroll offset of the document.
     * @return mixed integer on get, the result of window.scrollTo on set
    **/
    scrollTop: function(scroll){
        var setScroll = typeof scroll !== 'undefined';

        if(setScroll) {
            return window.scrollTo(0, scroll);
        }
        if(typeof window.pageYOffset !== 'undefined') {
            return window.pageYOffset;
        }
        else if(document.documentElement.clientHeight) {
            return document.documentElement.scrollTop;
        }
        else {
            return document.body.scrollTop;
        }
    },

    /**
     * scrollTo - Smooth scroll to the point of scrollEnd in the document.
     * @return void
    **/
    curScrollStep: 0,
    scrollTo: function (scrollStart, scrollEnd, steps, interval) {
        if(
            (scrollStart < scrollEnd && readability.scrollTop() < scrollEnd) ||
            (scrollStart > scrollEnd && readability.scrollTop() > scrollEnd)
          ) {
            readability.curScrollStep+=1;
            if(readability.curScrollStep > steps) {
                return;
            }

            var oldScrollTop = readability.scrollTop();

            readability.scrollTop(readability.easeInOut(scrollStart, scrollEnd, steps, readability.curScrollStep));

            // We're at the end of the window.
            if(oldScrollTop === readability.scrollTop()) {
                return;
            }

            window.setTimeout(function() {
                readability.scrollTo(scrollStart, scrollEnd, steps, interval);
            }, interval);
        }
    },

    htmlspecialchars: function (s) {
        if (typeof(s) === "string") {
            s = s.replace(/&/g, "&amp;");
            s = s.replace(/"/g, "&quot;");
            s = s.replace(/'/g, "&#039;");
            s = s.replace(/</g, "&lt;");
            s = s.replace(/>/g, "&gt;");
        }

        return s;
    },

    flagIsActive: function(flag) {
        return (readability.flags & flag) > 0;
    },

    addFlag: function(flag) {
        readability.flags = readability.flags | flag;
    },

    removeFlag: function(flag) {
        readability.flags = readability.flags & ~flag;
    }

};

if (typeof module === "object") {
  module.exports = readability;
}

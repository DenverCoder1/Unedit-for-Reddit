// ==UserScript==
// @name         Unedit and Undelete for Reddit
// @namespace    http://tampermonkey.net/
// @version      3.8.0
// @description  Creates the option next to edited and deleted Reddit comments/posts to show the original comment from before it was edited
// @author       Jonah Lawrence (DenverCoder1)
// @match        *://*reddit.com/*
// @include      https://*.reddit.com/*
// @include      https://reddit.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/showdown@2.1.0/dist/showdown.min.js
// @license      MIT
// ==/UserScript==

/* jshint esversion: 8 */

(function () {
    "use strict";

    /**
     * Whether or not we are on old reddit and not redesign.
     * This will be set in the "load" event listener.
     * @type {boolean}
     */
    let isOldReddit = false;

    /**
     * Timeout to check for new edited comments on page.
     * This will be updated when scrolling.
     * @type {number?}
     */
    let scriptTimeout = null;

    /**
     * The element that is currently requesting content
     * @type {Element?}
     */
    let currentLoading = null;

    /**
     * Showdown markdown converter
     * @type {showdown.Converter}
     */
    const mdConverter = new showdown.Converter();

    /**
     * Logging methods for displaying formatted logs in the console.
     *
     * logging.info("This is an info message");
     * logging.warn("This is a warning message");
     * logging.error("This is an error message");
     * logging.table({a: 1, b: 2, c: 3});
     */
    const logging = {
        INFO: "info",
        WARN: "warn",
        ERROR: "error",
        TABLE: "table",

        /**
         * Log a message to the console
         * @param {string} level The console method to use e.g. "log", "info", "warn", "error", "table"
         * @param {...string} messages - Any number of messages to log
         */
        _format_log(level, ...messages) {
            const logger = level in console ? console[level] : console.log;
            logger(`%c[unedit-for-reddit] %c[${level.toUpperCase()}]`, "color: #00b6b6", "color: #888800", ...messages);
        },

        /**
         * Log an info message to the console
         * @param {...string} messages - Any number of messages to log
         */
        info(...messages) {
            logging._format_log(this.INFO, ...messages);
        },

        /**
         * Log a warning message to the console
         * @param {...string} messages - Any number of messages to log
         */
        warn(...messages) {
            logging._format_log(this.WARN, ...messages);
        },

        /**
         * Log an error message to the console
         * @param {...string} messages - Any number of messages to log
         */
        error(...messages) {
            logging._format_log(this.ERROR, ...messages);
        },

        /**
         * Log a table to the console
         * @param {Object} data - The table to log
         */
        table(data) {
            logging._format_log(this.TABLE, data);
        },
    };

    /**
     * Find the ID of a comment or submission.
     * @param {Element} innerEl An element inside the comment.
     * @returns {string} The Reddit ID of the comment.
     */
    function getPostId(innerEl) {
        let postId = "";
        // redesign
        if (!isOldReddit) {
            const post = innerEl?.closest("[class*='t1_'], [class*='t3_']");
            postId = Array.from(post.classList).filter(function (el) {
                return el.indexOf("t1_") > -1 || el.indexOf("t3_") > -1;
            })[0];
        }
        // old reddit
        else {
            // old reddit comment
            postId = innerEl?.parentElement?.parentElement?.parentElement?.id.replace("thing_", "");
            // old reddit submission
            if (!postId && isInSubmission(innerEl)) {
                const match = window.location.href.match(/comments\/([A-Za-z0-9]{5,8})\//);
                postId = match ? match[1] : null;
                // submission in list view
                if (!postId) {
                    const thing = innerEl.closest(".thing");
                    postId = thing?.id.replace("thing_", "");
                }
            }
            // if still not found, check for the .reportform element
            if (!postId) {
                postId = innerEl.parentElement.parentElement
                    .getElementsByClassName("reportform")[0]
                    .className.replace(/.*t1/, "t1");
            }
        }
        return postId;
    }

    /**
     * Get the container of the comment or submission body for appending the original comment to.
     * @param {string} postId The ID of the comment or submission
     * @returns {Element} The container element of the comment or submission body.
     */
    function getPostBodyElement(postId) {
        let bodyEl = null,
            baseEl = null;
        // redesign
        if (!isOldReddit) {
            baseEl = document.querySelector(`#${postId}, .Comment.${postId}`);
            if (baseEl) {
                if (baseEl.getElementsByClassName("RichTextJSON-root").length > 0) {
                    bodyEl = baseEl.getElementsByClassName("RichTextJSON-root")[0];
                } else if (isInSubmission(baseEl) && baseEl?.firstElementChild?.lastElementChild) {
                    bodyEl = baseEl.firstElementChild.lastElementChild;
                } else {
                    bodyEl = baseEl;
                }
            }
        }
        // old reddit
        else {
            // old reddit comments
            baseEl = document.querySelector(`form[id*='${postId}'] .md`);
            if (baseEl?.closest(".entry")) {
                bodyEl = baseEl;
            } else {
                baseEl = document.querySelector(".report-" + postId);
                bodyEl = baseEl ? baseEl.closest(".entry").querySelector(".usertext") : null;
            }
            // old reddit submissions
            if (!bodyEl) {
                bodyEl =
                    document.querySelector("div[data-url] .entry form .md") ||
                    document.querySelector("div[data-url] .entry form .usertext-body");
            }
            // link view
            if (!bodyEl) {
                bodyEl = document.querySelector(`.id-${postId}`);
            }
        }
        return bodyEl;
    }

    /**
     * Check if surrounding elements imply element is in a selftext submission.
     * @param {Element} innerEl An element inside the post to check.
     * @returns {boolean} Whether or not the element is in a selftext submission
     */
    function isInSubmission(innerEl) {
        const selectors = [
            "a.thumbnail", // old reddit on profile page or list view
            "div[data-url]", // old reddit on submission page
            ".Post", // redesign
        ];
        return Boolean(innerEl.closest(selectors.join(", ")));
    }

    /**
     * Check if the element bounds are within the window bounds.
     * @param {Element} element The element to check
     * @returns {boolean} Whether or not the element is within the window
     */
    function isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    /**
     * Create a new paragraph containing the body of the original comment/post.
     * @param {Element} commentBodyElement The container element of the comment/post body.
     * @param {string} postType The type of post - "comment" or "post" (submission)
     * @param {string} originalBody The body of the original comment/post.
     */
    function showOriginalComment(commentBodyElement, postType, originalBody) {
        // create paragraph element
        const origBodyEl = document.createElement("p");
        origBodyEl.className = "og";
        // set text
        origBodyEl.innerHTML = mdConverter.makeHtml("\n\n### Original " + postType + ":\n\n" + originalBody);
        // paragraph styling
        origBodyEl.style.opacity = 0.96;
        origBodyEl.style.fontSize = "14px";
        origBodyEl.style.background = "#fff59d";
        origBodyEl.style.padding = "16px";
        origBodyEl.style.color = "black";
        origBodyEl.style.lineHeight = "20px";
        commentBodyElement.appendChild(origBodyEl);
        // scroll into view
        setTimeout(function () {
            if (!isInViewport(origBodyEl)) {
                origBodyEl.scrollIntoView({ behavior: "smooth" });
            }
        }, 500);
        // on old reddit, if the comment is collapsed, expand it so the original comment is visible
        if (isOldReddit) {
            expandComment(commentBodyElement);
        }
    }

    /**
     * Expand comment if it is collapsed (on old reddit only).
     * @param {Element} innerEl An element inside the comment.
     */
    function expandComment(innerEl) {
        const collapsedComment = innerEl.closest(".collapsed");
        if (collapsedComment) {
            collapsedComment.classList.remove("collapsed");
            collapsedComment.classList.add("noncollapsed");
        }
    }

    /**
     * Create a link to view the original comment/post.
     * @param {Element} innerEl An element inside the comment or post to create a link for.
     */
    function createLink(innerEl) {
        // if there is already a link, don't create another
        if (innerEl.parentElement.querySelector("a.showOriginal")) {
            return;
        }
        // create link to "Show orginal"
        const showLinkEl = document.createElement("a");
        showLinkEl.innerText = "Show original";
        showLinkEl.className = innerEl.className + " showOriginal";
        showLinkEl.style.textDecoration = "underline";
        showLinkEl.style.cursor = "pointer";
        showLinkEl.style.marginLeft = "6px";
        innerEl.parentElement.appendChild(showLinkEl);
        innerEl.classList.add("match");
        // find id of selected comment or submission
        const postId = getPostId(showLinkEl);
        showLinkEl.alt = `View original post for ID ${postId}`;
        if (!postId) {
            showLinkEl.style.color = "#dd2c00";
        }
        // click event
        showLinkEl.addEventListener(
            "click",
            async function () {
                // allow only 1 request at a time
                if (typeof currentLoading != "undefined" && currentLoading !== null) {
                    return;
                }
                // create url for getting comment/post from pushshift api
                const idURL = isInSubmission(this)
                    ? "https://api.pushshift.io/reddit/search/submission/?ids=" +
                      postId +
                      "&sort=desc&sort_type=created_utc&fields=selftext,author,id"
                    : "https://api.pushshift.io/reddit/search/comment/?ids=" +
                      postId +
                      "&sort=desc&sort_type=created_utc&fields=body,author,id,link_id";
                // create url for getting author comments/posts from pushshift api
                const author = this.parentElement.querySelector("a[href*=user]")?.innerText;
                const authorURL = isInSubmission(this)
                    ? "https://api.pushshift.io/reddit/search/submission/?author=" +
                      author +
                      "&size=200&sort=desc&sort_type=created_utc&fields=selftext,author,id"
                    : "https://api.pushshift.io/reddit/search/comment/?author=" +
                      author +
                      "&size=200&sort=desc&sort_type=created_utc&fields=body,author,id,link_id";

                // set loading status
                currentLoading = this;
                this.innerHTML = "loading...";

                logging.info("Fetching from " + idURL + " and " + authorURL);

                // request from pushshift api
                await Promise.all([
                    fetch(idURL)
                        .then((resp) => resp.json())
                        .catch((error) => {
                            logging.error("Error:", error);
                        }),
                    fetch(authorURL)
                        .then((resp) => resp.json())
                        .catch((error) => {
                            logging.error("Error:", error);
                        }),
                ])
                    .then((responses) => {
                        responses.forEach((out) => {
                            // locate the comment that was being loaded
                            const loading = currentLoading;
                            // exit if already found
                            if (loading.innerHTML === "") {
                                return;
                            }
                            // locate comment body
                            const commentBodyElement = getPostBodyElement(postId);
                            const post = out?.data?.find((p) => p?.id === postId?.split("_").pop());
                            logging.info("Response:", { author, id: postId, post, data: out?.data });
                            // check that comment was fetched and body element exists
                            if (!commentBodyElement) {
                                // the comment body element was not found
                                loading.innerHTML = "body element not found";
                                logging.error("Body element not found:", out);
                            } else if (post?.body) {
                                // create new paragraph containing the body of the original comment
                                showOriginalComment(commentBodyElement, "comment", post.body);
                                // remove loading status from comment
                                loading.innerHTML = "";
                            } else if (post?.selftext) {
                                // check if result has selftext instead of body (it is a submission post)
                                // create new paragraph containing the selftext of the original submission
                                showOriginalComment(commentBodyElement, "post", post.selftext);
                                // remove loading status from post
                                loading.innerHTML = "";
                            } else if (out?.data?.length === 0) {
                                // data was returned empty
                                loading.innerHTML = "not found";
                                logging.warn("No results:", out);
                            } else if (out?.data?.length > 0) {
                                // no matching comment/post was found in the data
                                loading.innerHTML = "not found";
                                logging.warn("No matching post:", out);
                            } else {
                                // other issue occurred with displaying comment
                                loading.innerHTML = "fetch failed";
                                logging.error("Fetch failed:", out);
                            }
                        });
                    })
                    .catch(function (err) {
                        throw err;
                    });

                // reset status
                currentLoading = null;
            },
            false
        );
    }

    /**
     * Locate comments and add links to each.
     */
    function findEditedComments() {
        // when function runs, cancel timeout
        if (scriptTimeout) {
            scriptTimeout = null;
        }
        // list elements to check for edited or deleted status
        let selectors = [],
            elementsToCheck = [],
            editedComments = [];
        // redesign
        if (!isOldReddit) {
            selectors = [
                ".Comment div:first-of-type span span:not(.found)", // Comments "edited..." or "Comment deleted/removed..."
                ".Post div div div:last-of-type div ~ div:last-of-type:not(.found)", // Submissions "It doesn't appear in any feeds..." message
            ];
            elementsToCheck = Array.from(document.querySelectorAll(selectors.join(", ")));
            editedComments = elementsToCheck.filter(function (el) {
                el.classList.add("found");
                return (
                    el.innerText.substring(0, 6) === "edited" || // include edited comments
                    el.innerText.substring(0, 15) === "Comment deleted" || // include comments deleted by user
                    el.innerText.substring(0, 15) === "Comment removed" || // include comments removed by moderator
                    el.innerText.substring(0, 30) === "It doesn't appear in any feeds" || // include deleted submissions
                    el.innerText.substring(0, 23) == "Moderators remove posts" // include submissions removed by moderators
                );
            });
        }
        // old Reddit
        else {
            selectors = [
                ".entry p.tagline time:not(.found)", // Comment or Submission "last edited" timestamp
                ".entry p.tagline em:not(.found)", // Comment "[deleted]" author
                "div[data-url] p.tagline span:first-of-type:not(.found)", // Submission "[deleted]" author
                "div[data-url] .usertext-body em:not(.found)", // Submission "[removed]" body
            ];
            elementsToCheck = Array.from(document.querySelectorAll(selectors.join(", ")));
            editedComments = elementsToCheck.filter(function (el) {
                el.classList.add("found");
                return (
                    el.title.substring(0, 11) === "last edited" || // include edited comments or submissions
                    el.innerText === "[deleted]" || // include comments or submissions deleted by user
                    el.innerText === "[removed]" // include comments or submissions removed by moderator
                );
            });
        }
        // create links
        editedComments.forEach(function (x) {
            createLink(x);
        });
    }

    // check for new comments when you scroll
    window.addEventListener(
        "scroll",
        function () {
            if (!scriptTimeout) {
                scriptTimeout = setTimeout(findEditedComments, 1000);
            }
        },
        true
    );

    // add additional styling, find edited comments, and set old reddit status on page load
    window.addEventListener("load", function () {
        // determine if reddit is old or redesign
        isOldReddit = /old\.reddit/.test(window.location.href) || !!document.querySelector("#header-img");
        // fix styling of created paragraphs in new reddit
        if (!isOldReddit) {
            document.head.insertAdjacentHTML(
                "beforeend",
                "<style>p.og pre { font-family: monospace; background: #fff59d; padding: 6px; margin: 6px 0; color: black; } p.og h1 { font-size: 2em; } p.og h2 { font-size: 1.5em; } p.og > h3:first-child { font-weight: bold; margin-bottom: 0.5em; } p.og h3 { font-size: 1.17em; } p.og h4 { font-size: 1em; } p.og h5 { font-size: 0.83em; } p.og h6 { font-size: 0.67em; } p.og a { color: lightblue; text-decoration: underline; }</style>"
            );
        }
        // find edited comments
        findEditedComments();
    });
})();

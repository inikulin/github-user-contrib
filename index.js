var Promise     = require('pinkie-promise');
var ProgressBar = require('progress');
var Table       = require('cli-table');
var cheerio     = require('cheerio');
var chalk       = require('chalk');
var request     = require('request');
var format      = require('util').format;
var moment      = require('moment');

var CONTRIB_CHUNK_URL_TMPL = 'https://github.com/%s?tab=contributions&from=%s&to=%s';
var DAYS_PER_CHUNK         = 31;

var DATE_FORMAT = 'YYYY-MM-DD';

var HEADER_SELECTOR       = 'h3.conversation-list-heading';
var LIST_SELECTOR         = '.simple-conversation-list';
var PROJECT_NAME_SELECTOR = 'span.cmeta';

var COMMIT_HEADER_TEXT_RE       = /\d+ commits?/i;
var PULL_REQUEST_HEADER_TEXT_RE = /\d+ pull requests?/i;
var ISSUES_HEADER_TEXT_RE       = /\d+ issues? reported/i;

var COMMIT_TEXT_RE = /Pushed (\d+) commits? to (.+)/;

var username = process.argv[2];

var commitsTotal      = 0;
var pullRequestsTotal = 0;
var issuesTotal       = 0;

var projectStats = {};

function get (url) {
    return new Promise(function (resolve, reject) {
        var opts = {
            url:     url,
            forever: true
        };

        request(opts, function (err, res) {
            if (err)
                reject(err);

            else if (res.statusCode === 429)
                reject('Too many requests to GitHub. Please, wait a minute and try again.');

            else if (res.statusCode === 404)
                reject('Unknown username "' + username + '".');

            else if (res.statusCode !== 200)
                reject('GitHub responded with status code ' + res.statusCode + '.');

            else
                resolve(res);
        });
    });
}

function reportError (err) {
    var msg = typeof err === 'string' ? err : err.message + '\n' + err.stack;

    console.error('\n' + chalk.red.bold('ERROR') + ' ' + msg);
    process.exit(1);
}

function getProjectStats (projectName) {
    projectName = projectName.trim();

    if (!projectStats[projectName]) {
        projectStats[projectName] = {
            commits:      0,
            pullRequests: 0,
            issues:       0
        };
    }

    return projectStats[projectName];
}

function getListItems ($, headerTextRe) {
    return $(HEADER_SELECTOR)
        .filter(function (idx, el) {
            var headerText = $(el).text();

            return headerTextRe.test(headerText);
        })
        .next(LIST_SELECTOR)
        .find('li');
}

function parseCommits ($) {
    var $commits = getListItems($, COMMIT_HEADER_TEXT_RE);

    $commits.each(function (idx, el) {
        var text    = $(el).find('a').text();
        var match   = text.match(COMMIT_TEXT_RE);
        var stats   = getProjectStats(match[2]);
        var commits = parseInt(match[1], 10);

        commitsTotal += commits;
        stats.commits += commits;
    });
}

function parsePullRequests ($) {
    var $prs = getListItems($, PULL_REQUEST_HEADER_TEXT_RE);

    pullRequestsTotal += $prs.length;

    $prs.each(function (idx, el) {
        var projectName = $(el).find(PROJECT_NAME_SELECTOR).text();
        var stats       = getProjectStats(projectName);

        stats.pullRequests++;
    });
}

function parseIssues ($) {
    var $issues = getListItems($, ISSUES_HEADER_TEXT_RE);

    issuesTotal += $issues.length;

    $issues.each(function (idx, el) {
        var projectName = $(el).find(PROJECT_NAME_SELECTOR).text();
        var stats       = getProjectStats(projectName);

        stats.issues++;
    });
}

function parseChunkStats (res) {
    var $ = cheerio.load(res.body);

    parseCommits($);
    parsePullRequests($);
    parseIssues($);
}

function getChunkStatsUrls (from, to) {
    var urls       = [];
    var chunkStart = from;

    while (!chunkStart.isAfter(to)) {
        var chunkDays = Math.min(DAYS_PER_CHUNK, to.diff(chunkStart, 'days'));
        var chunkEnd  = moment(chunkStart).add(chunkDays, 'days');
        var url       = format(CONTRIB_CHUNK_URL_TMPL, username, chunkStart.format(DATE_FORMAT), chunkEnd.format(DATE_FORMAT));

        urls.push(url);

        chunkStart = chunkEnd.add(1, 'days');
    }

    return urls;
}

function fetchStats (from, to) {
    var chunkUrls = getChunkStatsUrls(from, to);

    var progress = new ProgressBar('Fetching data: [:bar] :percent', {
        total: chunkUrls.length,
        width: 50,
        clear: true
    });

    var progressTick = progress.tick.bind(progress);

    var chunkStatsPromises = chunkUrls.map(function (url) {
        return get(url)
            .then(parseChunkStats)
            .then(progressTick);
    });

    return Promise.all(chunkStatsPromises);
}

function printStats () {
    var total = commitsTotal + pullRequestsTotal + issuesTotal;

    var table = new Table({
        head:      ['Project', 'Comm', 'PR', 'Iss', 'Total'],
        colWidths: [40, 6, 6, 6, 7]
    });

    Object.keys(projectStats)
        .sort()
        .forEach(function (projectName) {
            var stats        = getProjectStats(projectName);
            var projectTotal = stats.commits + stats.pullRequests + stats.issues;

            table.push([projectName, stats.commits, stats.pullRequests, stats.issues, projectTotal]);
        });

    table.push([chalk.blue('Total'), commitsTotal, pullRequestsTotal, issuesTotal, total]);

    console.log(table.toString());
}

(function run () {
    var to   = moment();
    var from = moment(to).subtract(1, 'year');

    if (!username)
        reportError('You should specify the username');


    fetchStats(from, to)
        .then(printStats)
        .catch(reportError);
})();


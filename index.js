var Promise     = require('pinkie-promise');
var ProgressBar = require('progress');
var Table       = require('cli-table');
var cheerio     = require('cheerio');
var chalk       = require('chalk');
var request     = require('request');
var split       = require('split-array');
var format      = require('util').format;

var CONTRIB_CALENDAR_URL_TMPL = 'https://github.com/users/%s/contributions';
var CONTRIB_MONTH_URL_TMPL    = 'https://github.com/%s?tab=contributions&from=%s&to=%s';

var DAY_SELECTOR          = 'rect.day';
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

function getMonthStatsUrls (userPageBody) {
    var $ = cheerio.load(userPageBody);

    var days = $(DAY_SELECTOR)
        .map(function (idx, el) {
            return $(el).attr('data-date');
        })
        .get()
        .sort();

    return split(days, 30).map(function (month) {
        return format(CONTRIB_MONTH_URL_TMPL, username, month[0], month[month.length - 1]);
    });
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

function parseMonthCommits ($) {
    var $commits = getListItems($, COMMIT_HEADER_TEXT_RE);

    commitsTotal += $commits.length;

    $commits.each(function (idx, el) {
        var text  = $(el).find('a').text();
        var match = text.match(COMMIT_TEXT_RE);
        var stats = getProjectStats(match[2]);

        stats.commits += parseInt(match[1], 10);
    });
}

function parseMonthPullRequests ($) {
    var $prs = getListItems($, PULL_REQUEST_HEADER_TEXT_RE);

    pullRequestsTotal += $prs.length;

    $prs.each(function (idx, el) {
        var projectName = $(el).find(PROJECT_NAME_SELECTOR).text();
        var stats       = getProjectStats(projectName);

        stats.pullRequests++;
    });
}

function parseMonthIssues ($) {
    var $issues = getListItems($, ISSUES_HEADER_TEXT_RE);

    issuesTotal += $issues.length;

    $issues.each(function (idx, el) {
        var projectName = $(el).find(PROJECT_NAME_SELECTOR).text();
        var stats       = getProjectStats(projectName);

        stats.issues++;
    });
}

function parseMonthStats (res) {
    var $ = cheerio.load(res.body);

    parseMonthCommits($);
    parseMonthPullRequests($);
    parseMonthIssues($);
}

function fetchYearStats (calendarPageRes) {
    var monthUrls = getMonthStatsUrls(calendarPageRes.body);

    var progress = new ProgressBar('Fetching data: [:bar] :percent', {
        total: monthUrls.length,
        width: 50,
        clear: true
    });

    var progressTick = progress.tick.bind(progress);

    var monthStatsPromises = monthUrls.map(function (url) {
        return get(url)
            .then(parseMonthStats)
            .then(progressTick);
    });

    return Promise.all(monthStatsPromises);
}

function printStats () {
    var table = new Table({
        head:      ['Project', 'C', 'PR', 'I'],
        colWidths: [50, 6, 6, 6]
    });

    Object.keys(projectStats)
        .sort()
        .forEach(function (projectName) {
            var stats = getProjectStats(projectName);

            table.push([projectName, stats.commits, stats.pullRequests, stats.issues]);
        });

    table.push([chalk.blue('Total'), commitsTotal, pullRequestsTotal, issuesTotal]);

    console.log(table.toString());
}

(function run () {
    if (!username)
        reportError('You should specify the username');

    var contribCalendarUrl = format(CONTRIB_CALENDAR_URL_TMPL, username);

    get(contribCalendarUrl)
        .then(fetchYearStats)
        .then(printStats)
        .catch(reportError);
})();


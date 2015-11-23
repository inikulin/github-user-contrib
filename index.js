var Promise     = require('pinkie-promise');
var ProgressBar = require('progress');
var Table       = require('cli-table');
var cheerio     = require('cheerio');
var chalk       = require('chalk');
var request     = require('request');
var split       = require('split-array');
var format      = require('util').format;

var USER_PAGE_URL_TMPL     = 'https://github.com/%s';
var CONTRIB_MONTH_URL_TMPL = 'https://github.com/%s?tab=contributions&from=%s&to=%s';

var DAY_SELECTOR    = 'rect.day';
var HEADER_SELECTOR = 'h3.conversation-list-heading';

var COMMIT_HEADER_TEXT_RE = /\d+ commits?/;
var COMMIT_TEXT_RE        = /Pushed (\d+) commits? to (.+)/;

var username = process.argv[2];

var commitsTotal      = 0;
var pullRequestsTotal = 0;
var issuesTotal       = 0;

var projectStats = {};

function get (url) {
    return new Promise(function (resolve, reject) {
        request({
            url:     url,
            forever: true
        }, function (err, res) {
            if (err)
                reject(err);

            if (res.statusCode === 429)
                error('Too many requests to GitHub. Please, wait a minute and try again.');

            if (res.statusCode !== 200)
                error('GitHub responded with status code ' + res.statusCode);

            resolve(res);
        });
    });
}

function error (text) {
    console.error('\n' + chalk.red.bold('ERROR') + ' ' + text);
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

function getMonthContribInfoUrls (userPageBody) {
    var $ = cheerio.load(userPageBody);

    var days = $(DAY_SELECTOR)
        .map(function (idx, el) {
            return $(el).attr('data-date');
        })
        .get()
        .sort();

    return split(days, 30)
        .map(function (month) {
            return format(CONTRIB_MONTH_URL_TMPL, username, month[0], month[month.length - 1]);
        });
}

function parseMonthCommits ($) {
    var $commits = $(HEADER_SELECTOR)
        .filter(function (idx, el) {
            var headerText = $(el).text();

            return COMMIT_HEADER_TEXT_RE.test(headerText);
        })
        .next('ul')
        .find('li');

    commitsTotal += $commits.length;

    $commits.each(function (idx, el) {
        var text  = $(el).find('a').text();
        var match = text.match(COMMIT_TEXT_RE);
        var stats = getProjectStats(match[2]);

        stats.commits += parseInt(match[1], 10);
    });
}

function parseMonthStats (res) {
    var $ = cheerio.load(res.body);

    parseMonthCommits($);
}

function fetchYearStats (userPageBody) {
    var monthUrls = getMonthContribInfoUrls(userPageBody);

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

    console.log(table.toString());
}

(function run () {
    if (!username)
        error('You should specify the username');

    var userPageUrl = format(USER_PAGE_URL_TMPL, username);

    get(userPageUrl)
        .then(function (res) {
            if (res.statusCode === 404)
                error('Unknown username "' + username + '"');

            return fetchYearStats(res.body);
        })
        .then(printStats)
        .catch(function (err) {
            error(err.message + '\n' + err.stack);
        });
})();


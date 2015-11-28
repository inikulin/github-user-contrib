var Promise     = require('pinkie-promise');
var ProgressBar = require('progress');
var Table       = require('cli-table');
var cheerio     = require('cheerio');
var chalk       = require('chalk');
var request     = require('request');
var moment      = require('moment');
var repeat      = require('repeat-string');
var windowSize  = require('window-size');
var wordwrap    = require('wordwrap');
var Command     = require('commander').Command;
var readPkgUp   = require('read-pkg-up').sync;
var compareFunc = require('compare-func');
var format      = require('util').format;
var resolveUrl  = require('url').resolve;


// Const
var GITHUB_URL             = 'https://github.com';
var COMMITS_URL_TEMPLATE   = 'https://github.com/inikulin/%s/commits?author=%s';
var CONTRIB_CHUNK_URL_TMPL = 'https://github.com/%s?tab=contributions&from=%s&to=%s';

var DAYS_PER_CHUNK = 31;
var DATE_FORMAT    = 'YYYY-MM-DD';

var HEADER_SELECTOR       = 'h3.conversation-list-heading';
var LIST_SELECTOR         = '.simple-conversation-list';
var PROJECT_NAME_SELECTOR = 'span.cmeta';
var ITEM_TITLE_SELECTOR   = 'a.title';
var ITEM_STATE_SELECTOR   = 'span.state';

var COMMIT_HEADER_TEXT_RE       = /\d+ commits?/i;
var PULL_REQUEST_HEADER_TEXT_RE = /\d+ pull requests?/i;
var ISSUES_HEADER_TEXT_RE       = /\d+ issues? reported/i;
var COMMIT_TEXT_RE              = /pushed (\d+) commits? to (.+)/i;

var ITEM_STATE_STYLE = {
    open:   chalk.green,
    closed: chalk.red,
    merged: chalk.blue
};

var WINDOW_WIDTH = process.stdout.isTTY ? windowSize.width : 80;


// Program
var program = new Command('github-user-contrib');

program
    .version(readPkgUp().pkg.version)
    .usage('<username> [options]')
    .option('-r, --reporter <type>', 'specify the reporter type to use (table|verbose|json)', /^(table|verbose|json)$/i, 'table')
    .option('-s, --sort <by>', 'specify the sorting property (project|commits|pr|issues|total)', /^(project|commits|pr|issues|total)$/i, 'project')
    .parse(process.argv);


// Globals
var username = program.args[0];
var opts     = program.opts();

var stats = {
    commitsTotal:      0,
    pullRequestsTotal: 0,
    issuesTotal:       0,
    projectStats:      {}
};


// Utils
function reportError (err) {
    var msg = typeof err === 'string' ? err : err.message + '\n' + err.stack;

    console.error('\n' + chalk.red.bold('ERROR') + ' ' + msg);
    process.exit(1);
}

function getProjectStats (projectName) {
    projectName = projectName.trim();

    if (!stats.projectStats[projectName]) {
        stats.projectStats[projectName] = {
            commits: {
                count: 0,
                url:   format(COMMITS_URL_TEMPLATE, projectName, username)
            },

            pullRequests: [],
            issues:       []
        };
    }

    return stats.projectStats[projectName];
}


// Parsing
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
        var text         = $(el).find('a').text();
        var match        = text.match(COMMIT_TEXT_RE);
        var projectStats = getProjectStats(match[2]);
        var commitCount  = parseInt(match[1], 10);

        stats.commitsTotal += commitCount;
        projectStats.commits.count += commitCount;
    });
}

function parseVariedStateItem ($el, statsType) {
    var $title       = $el.find(ITEM_TITLE_SELECTOR);
    var projectName  = $el.find(PROJECT_NAME_SELECTOR).text();
    var projectStats = getProjectStats(projectName);

    projectStats[statsType].push({
        title: $title.text().trim(),
        url:   resolveUrl(GITHUB_URL, $title.attr('href')),
        state: $el.find(ITEM_STATE_SELECTOR).text().trim().toLowerCase()
    });
}

function parsePullRequests ($) {
    var $prs = getListItems($, PULL_REQUEST_HEADER_TEXT_RE);

    stats.pullRequestsTotal += $prs.length;

    $prs.each(function (idx, el) {
        parseVariedStateItem($(el), 'pullRequests');
    });
}

function parseIssues ($) {
    var $issues = getListItems($, ISSUES_HEADER_TEXT_RE);

    stats.issuesTotal += $issues.length;

    $issues.each(function (idx, el) {
        parseVariedStateItem($(el), 'issues');
    });
}

function parseChunkStats (res) {
    var $ = cheerio.load(res.body);

    parseCommits($);
    parsePullRequests($);
    parseIssues($);
}

// Fetching
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


// Printing
function getSortComparer () {
    switch (opts.sort) {
        case 'commits':
            return compareFunc(function (projectName) {
                return getProjectStats(projectName).commits.count;
            });

        case 'pr':
            return compareFunc(function (projectName) {
                return getProjectStats(projectName).pullRequests.length;
            });

        case 'issues':
            return compareFunc(function (projectName) {
                return getProjectStats(projectName).issues.length;
            });

        case 'total':
            return compareFunc(function (projectName) {
                var projectStats = getProjectStats(projectName);

                return projectStats.commits.count + projectStats.pullRequests.length + projectStats.issues.length;
            });

        default:
            return void 0;
    }

}

function printTable () {
    var table = new Table({
        head:      ['Project', 'Comm', 'PR', 'Iss', 'Total'],
        colWidths: [40, 6, 6, 6, 7]
    });

    Object.keys(stats.projectStats)
        .sort(getSortComparer())
        .forEach(function (projectName) {
            var projectStats = getProjectStats(projectName);
            var projectTotal = projectStats.commits.count +
                               projectStats.pullRequests.length +
                               projectStats.issues.length;

            table.push([
                projectName,
                projectStats.commits.count,
                projectStats.pullRequests.length,
                projectStats.issues.length, projectTotal
            ]);
        });

    var total = stats.commitsTotal + stats.pullRequestsTotal + stats.issuesTotal;

    table.push([
        chalk.blue('Total'),
        stats.commitsTotal,
        stats.pullRequestsTotal,
        stats.issuesTotal,
        total
    ]);

    console.log(table.toString());
}

function printVariedStateItem (item) {
    var stateStyle = ITEM_STATE_STYLE[item.state];
    var wrap       = wordwrap(4, WINDOW_WIDTH);

    console.log(stateStyle('   ' + item.state.toUpperCase()));
    console.log(wrap(chalk.gray(item.title)));
    console.log('    [' + chalk.gray.underline(item.url) + ']');
}

function printVerbose () {
    Object.keys(stats.projectStats)
        .sort(getSortComparer())
        .forEach(function (projectName) {
            var projectStats = getProjectStats(projectName);
            var projectTotal = projectStats.commits.count +
                               projectStats.pullRequests.length +
                               projectStats.issues.length;

            var projectNameText = projectName + ' (' + projectTotal + ')';

            console.log(chalk.bold(' ' + projectNameText));
            console.log(' ' + repeat('-', projectNameText.length));

            if (projectStats.commits.count) {
                console.log(' ' + chalk.magenta('Commits (' + projectStats.commits.count + '):'));
                console.log('   ' + chalk.gray.underline(projectStats.commits.url));
                console.log();
            }

            if (projectStats.pullRequests.length) {
                console.log(' ' + chalk.magenta('Pull requests (' + projectStats.pullRequests.length + '):'));
                projectStats.pullRequests.forEach(printVariedStateItem);
                console.log();
            }

            if (projectStats.issues.length) {
                console.log(' ' + chalk.magenta('Issues (' + projectStats.issues.length + '):'));
                projectStats.issues.forEach(printVariedStateItem);
                console.log();
            }

            console.log();
        });

    console.log(repeat('-', WINDOW_WIDTH - 1));

    var total = stats.commitsTotal + stats.pullRequestsTotal + stats.issuesTotal;

    console.log(
        chalk.cyan('TOTAL (' + total + '):') +
        ' commits (' + chalk.gray(stats.commitsTotal) + '),' +
        ' pull requests (' + chalk.gray(stats.pullRequestsTotal) + '),' +
        ' issues (' + chalk.gray(stats.issuesTotal) + ')'
    );
}

function print () {
    switch (opts.reporter) {
        case 'verbose':
            printVerbose();
            break;

        case 'json':
            console.log(JSON.stringify(stats));
            break;

        default:
            printTable();
    }
}

// Entry point
(function run () {
    var to   = moment();
    var from = moment(to).subtract(1, 'year');

    if (!username)
        reportError('You should specify the username');


    fetchStats(from, to)
        .then(print)
        .catch(reportError);
})();


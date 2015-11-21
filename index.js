var Promise = require('pinkie-promise');
var cheerio = require('cheerio');
var chalk   = require('chalk');
var request = require('request');
var format  = require('util').format;

var USER_PAGE_URL_TMPL   = 'https://github.com/%s';
var CONTRIB_DAY_URL_TMPL = 'https://github.com/%s?tab=contributions&from=%s';
var DAY_SELECTOR         = 'rect.day';

var username = process.argv[2];

var commits      = 0;
var pullRequests = 0;
var issues       = 0;

var projectStats = {};

function get (url) {
    return new Promise(function (resolve) {
        request(url, function (err, res) {
            resolve(res);
        });
    });
}

function error (text) {
    console.log(chalk.red.bold('ERROR') + ' ' + text);
    process.exit(1);
}

function getContributionDayUrls (userPageBody) {
    var $ = cheerio.load(userPageBody);

    return $(DAY_SELECTOR)
        .filter(function (idx, el) {
            var countAttr = $(el).attr('data-count');

            return parseInt(countAttr, 10) > 0;
        })
        .map(function (idx, el) {
            var date = $(el).attr('data-date');

            return format(CONTRIB_DAY_URL_TMPL, username, date);
        })
        .get();
}

function createStatus (total) {
  // TODO
}

function fetchDateStats (url, progress) {
    return get(url)
        .then(function () {
            progress.tick();
        });
}

function fetchYearStats (userPageBody) {
    var dayUrls = getContributionDayUrls(userPageBody);
    var counter = createStatus(dayUrls.length);

    return dayUrls.reduce(function (fetchPromise, url) {
        return fetchPromise
            .then(function () {
                return get(url);
            })
            .then(function () {
                counter.inc();
            });
    }, Promise.resolve());
}

(function run () {
    if (!username)
        error('you should specify the username');

    console.log('Fetching data...');

    var userPageUrl = format(USER_PAGE_URL_TMPL, username);

    get(userPageUrl)
        .then(function (res) {
            if (res.statusCode === 404)
                error('unknown username "' + username + '"');

            return fetchYearStats(res.body);
        })
        .then(function () {
            console.log('done');
        })
        .catch(function (err) {
            error(err.message + '\n' + err.stack);
        });
})();


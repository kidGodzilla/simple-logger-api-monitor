/**
 * Simple Logger / API Monitor (SLAM) for Express
 */
module.exports = function (app) {
    const process = require('process');
    const os = require('os');

    // Middleware
    app.use(function (req, res, next) {
        if (!global.slamCounts) global.slamCounts = {}; // Create if not exists

        try {
            // Setup
            const time = process.hrtime();
            const NS_PER_SEC = 1e9;
            const NS_TO_MS = 1e6;

            // Environment Variables
            const log_long_requests = process.env.SLAM_LOG_LONG_REQUESTS || true;
            const console_logging_enabled = process.env.SLAM_DEBUG || false;
            const long_req = process.env.SLAM_MAX_REQUEST_LENGTH || 5000;

            // Generate a pseudo-unique UUID
            function uuidv4 () {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
            }

            // Get route name
            function getRoute (req) {
                const route = req.route ? req.route.path : '';
                const baseUrl = req.baseUrl ? req.baseUrl : '';
                return route ? `${ baseUrl === '/' ? '' : baseUrl }${ route }` : 'unknown route'
            }

            // Javascript timestamp to compressed segment
            function tsToSegment (ts) {
                if (!ts) ts = + new Date();
                return Math.floor(ts / (1000 * 60 * 5));
            }

            // Compressed segment to Javascript timestamp
            function segmentToTs (seg) {
                return seg * (1000 * 60 * 5);
            }

            // Fix value type
            function fixValueType (v) {
                if (v === 'undefined') v = undefined;
                if (v === 'false') v = false;
                if (v === 'null') v = null;
                if (v === 'true') v = true;
                if (v === 'NaN') v = NaN;

                if ((+v) == v && v !== '') v = (+v);
                return v;
            }

            // Return coerced type of
            function typeOf (v) {
                return typeof fixValueType(v);
            }

            // Log incoming parameters and types
            function logInfo (o) {
                if (!o || typeof o !== 'object') return {};
                let out = {};

                Object.keys(o).forEach(k => {
                    let type = typeOf(o[k]);
                    if (Array.isArray(o[k])) type = 'array';

                    out[k] = { namespace: k, type: type };
                });

                return out;
            }

            res.slam = { uuid: uuidv4(), timestamp: (+ new Date()), timeSegment: tsToSegment() };
            res.slam.hostname = process.env.SLAM_HOSTNAME || process.env.HOSTNAME || os.hostname();

            function log () {
                if (res.slam && res.slam.logged) return;
                if (res.slam) res.slam.logged = true;
                var obj = res.slam;

                // Check request duration
                const diff = process.hrtime(time);
                const ms = (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;

                // Store request
                res.slam.method = `${ req.method } ${ getRoute(req) }`;
                res.slam.statusCode = res.statusCode;
                res.slam.finished = res.finished;
                res.slam.durationMs = ms;

                // Log long requests
                if (log_long_requests && obj.durationMs > long_req) console.log('Long request:', obj.method, obj.durationMs);

                // Logging enabled
                if (console_logging_enabled) console.log(res.slam);

                // Create if not exists
                if (!global.slamCounts[obj.method]) global.slamCounts[obj.method] = { count: 0, avgDurationMs: 0, statusCodes: {} };

                if (!global.slamCounts[obj.method].statusCodes[obj.statusCode])
                    global.slamCounts[obj.method].statusCodes[obj.statusCode] = { count: 0, segments: {} };

                // Stash previous
                var prev = global.slamCounts[obj.method];

                // Increment
                global.slamCounts[obj.method].statusCodes[obj.statusCode].count++;
                global.slamCounts[obj.method].count++;

                // Compute avg request duration
                var new_avg_dur = (obj.durationMs + (prev.avgDurationMs * prev.count)) / (prev.count + 1);
                global.slamCounts[obj.method].avgDurationMs = new_avg_dur;

                // Compute new segments
                var segments = global.slamCounts[obj.method].statusCodes[obj.statusCode].segments;

                // Create if not exists
                if (!segments[obj.timeSegment]) segments[obj.timeSegment] = { count: 0, avgDurationMs: 0 };

                // Store count and avg duration
                prev = segments[obj.timeSegment];
                new_avg_dur = (obj.durationMs + (prev.avgDurationMs * prev.count)) / (prev.count + 1);

                segments[obj.timeSegment].avgDurationMs = new_avg_dur;
                segments[obj.timeSegment].count++;

                // Cleanup segments more than 2 hours old
                var minK = tsToSegment() - 23;

                for (var k in segments) {
                    if (k < minK) delete segments[k];
                }

                // Persist new segments to method / status code
                global.slamCounts[obj.method].statusCodes[obj.statusCode].segments = segments;

                // Append the last request params and types
                global.slamCounts[obj.method].namespaces = {
                    params: logInfo(req.params),
                    query: logInfo(req.query),
                    body: logInfo(req.body)
                };
            }

            res.on('finish', log);
            res.on('close', log);
            next();

        } catch(e) {
            console.log('Slam exception');
            next()
        }

    });

    // Return the raw counts and stats
    app.get('/slamCounts', function (req, res) {
        res.json(global.slamCounts);
    });

    // Render the view
    let routeName = '/monitor';
    let pageTitle = 'API Monitor';

    try {
        routeName = process.env.SLAM_MONITOR_PATH || '/monitor';
        pageTitle = process.env.SLAM_PAGE_TITLE || 'API Monitor';
    } catch(e){}

    app.get(routeName, function (req, res) {
        res.send(`<html> <head> <title>API Monitor</title> <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootswatch/4.3.1/cosmo/bootstrap.min.css" /> <style type="text/css"> .pt-8 { padding-top: 110px } .frappe-chart .x.axis text { display: none } </style> </head> <body> <div class="container" style="margin-top:30px"> <h2 class="text-center">${ pageTitle }</h2> <br/> <div class="charts"></div> </div> <script src="https://code.jquery.com/jquery-3.3.1.js"></script> <script src="https://cdn.jsdelivr.net/npm/frappe-charts@1.2.4/dist/frappe-charts.min.iife.js"></script> <script src="https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.24.0/moment.min.js"></script> <script> function segmentToTs(t){return 3e5*t}function tsToSegment(t){return t=t||+new Date,Math.floor(t/3e5)}function renderChart(t,a){var r=$('<div class="row"> <div class="col-md-10"> <div class="chart"></div> </div> <div class="col-md-1 align-middle pt-8"><strong class="reqs"></strong><strong> reqs.</strong> </div> <div class="col-md-1 align-middle pt-8"> <strong class="adur"></strong><strong>ms Avg.</strong> </div> </div>');r.find(".reqs").text(a.count),r.find(".adur").text(Math.round(a.avgDurationMs)),r.attr("data-k",t);for(var e={labels:[],datasets:[]},s=tsToSegment(),n=s-23,o=n;o<=s;o++){var i=moment(segmentToTs(o)).fromNow();e.labels.push(i)}for(var d in a.statusCodes){var c={name:d,chartType:"bar",values:[]};for(o=n;o<=s;o++){var l=0;try{l=a.statusCodes[d].segments[o].count}catch(t){}c.values.push(l)}e.datasets.push(c)}$(".container > .charts").append(r);new frappe.Chart(r.find(".chart")[0],{data:e,title:t,type:"bar",height:220,colors:["green"],barOptions:{stacked:!0,spaceRatio:.1},tooltipOptions:{formatTooltipX:function(t){return(t+"").toUpperCase()},formatTooltipY:function(t){return t+""}}})}function getData(){$.get("/slamCounts",function(t){for(var a in t&&$(".container > .charts").html(""),t){renderChart(a,t[a])}})}$(document).ready(function(){setInterval(getData,12e4),getData()}); </script> </body> </html>`);
    });
};

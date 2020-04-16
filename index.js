/**
 * Simple Logger / API Monitor (SLAM) for Express
 */
module.exports = function (app) {

    // Middleware
    app.use(function (req, res, next) {
        if (!global.slamCounts) global.slamCounts = {};

        try {

            var console_logging_enabled = false;
            var process = require('process');
            var os = require('os');

            function uuidv4 () {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
            }

            function getRoute (req) {
                const route = req.route ? req.route.path : '';
                const baseUrl = req.baseUrl ? req.baseUrl : '';
                return route ? `${ baseUrl === '/' ? '' : baseUrl }${ route }` : 'unknown route'
            }

            function segmentToTs (seg) {
                return seg * (1000 * 60 * 5);
            }

            function tsToSegment (ts) {
                if (!ts) ts = + new Date();
                return Math.floor(ts / (1000 * 60 * 5));
            }

            const time = process.hrtime();
            res.slam = { uuid: uuidv4(), timestamp: (+ new Date()), timeSegment: tsToSegment() };
            const NS_PER_SEC = 1e9;
            const NS_TO_MS = 1e6;

            res.slam.hostname = process.env.SLAM_HOSTNAME || process.env.HOSTNAME || os.hostname();

            // Todo: CPU Usage, Memory Usage, Avg. Response Time, Requests per second, etc.

            function log (obj) {
                if (res.slam && res.slam.logged) return;

                if (!global.slamCounts[obj.method]) global.slamCounts[obj.method] = { count: 0, avgDurationMs: 0, statusCodes: {} };

                if (!global.slamCounts[obj.method].statusCodes[obj.statusCode])
                    global.slamCounts[obj.method].statusCodes[obj.statusCode] = { count: 0, segments: {} };

                var prev = global.slamCounts[obj.method];

                global.slamCounts[obj.method].statusCodes[obj.statusCode].count++;
                global.slamCounts[obj.method].count++;

                var new_avg_dur = (obj.durationMs + (prev.avgDurationMs * prev.count)) / (prev.count + 1);
                global.slamCounts[obj.method].avgDurationMs = new_avg_dur;


                // Compute new segments
                var segments = global.slamCounts[obj.method].statusCodes[obj.statusCode].segments;

                if (!segments[obj.timeSegment]) segments[obj.timeSegment] = { count: 0, avgDurationMs: 0 };

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
            }

            res.on('close', function () {
                const diff = process.hrtime(time);
                const ms = (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;

                res.slam.method = `${ req.method } ${ getRoute(req) }`;
                res.slam.statusCode = res.statusCode;
                res.slam.finished = res.finished;
                res.slam.durationMs = ms;

                setTimeout(function () {
                    if (console_logging_enabled && !res.slam.logged) console.log(res.slam);
                    if (!res.slam.logged) log(res.slam);
                    res.slam.logged = true;
                }, 100);
            });

            res.on('finish', function () {
                const diff = process.hrtime(time);
                const ms = (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;

                res.slam.method = `${ req.method } ${ getRoute(req) }`;
                res.slam.statusCode = res.statusCode;
                res.slam.finished = res.finished;
                res.slam.durationMs = ms;

                if (console_logging_enabled && !res.slam.logged) console.log(res.slam);
                if (!res.slam.logged) log(res.slam);
                res.slam.logged = true;
            });

            next();

        } catch(e) { next() }

    });

    // Return the raw counts and stats
    app.get('/slamCounts', function (req, res) {
        res.json(global.slamCounts);
    });

    // Render the view
    app.get('/monitor', function (req, res) {
        res.send(`<html> <head> <title>Simple Logger / API Monitor</title> <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootswatch/4.3.1/cosmo/bootstrap.min.css" /> <style type="text/css"> .pt-8 {padding-top: 110px} .frappe-chart .x.axis text { display: none; } </style> </head> <body> <div class="container" style="margin-top:30px"> <h2 class="text-center">Simple Logger / API Monitor</h2> <br/> </div> <script src="https://code.jquery.com/jquery-3.3.1.js"></script> <script src="https://cdn.jsdelivr.net/npm/frappe-charts@1.2.4/dist/frappe-charts.min.iife.js"></script> <script src="https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.24.0/moment.min.js"></script> <script> function segmentToTs(t){return 3e5*t}function tsToSegment(t){return t||(t=+new Date),Math.floor(t/3e5)}$(document).ready(function(){var t='<div class="row"> <div class="col-md-10"> <div class="chart"></div> </div> <div class="col-md-1 align-middle pt-8"><strong class="reqs"></strong><strong> reqs.</strong> </div> <div class="col-md-1 align-middle pt-8"> <strong class="adur"></strong><strong>ms Avg.</strong> </div> </div>';function s(s,a){var o=$(t);o.find(".reqs").text(a.count),o.find(".adur").text(Math.round(a.avgDurationMs)),o.attr("data-k",s);for(var r={labels:[],datasets:[]},n=tsToSegment(),e=n-23,i=e;i<=n;i++){var d=moment(segmentToTs(i)).fromNow();r.labels.push(d)}for(var c in a.statusCodes){var l={name:c,chartType:"bar",values:[]};for(i=e;i<=n;i++){var u=0;try{u=a.statusCodes[c].segments[i].count}catch(t){}l.values.push(u)}r.datasets.push(l)}$(".container").append(o);new frappe.Chart(o.find(".chart")[0],{data:r,title:s,type:"bar",height:220,colors:["green"],barOptions:{stacked:!0,spaceRatio:.1},tooltipOptions:{formatTooltipX:function(t){return(t+"").toUpperCase()},formatTooltipY:function(t){return t+""}}})}$.get("/slamCounts",function(t){for(var a in t){var o=t[a];console.log(a,o),s(a,o)}})}); </script> </body> </html>`);
    });
};

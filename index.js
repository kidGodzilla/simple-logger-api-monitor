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
        res.send(`
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <meta name="mobile-web-app-capable" content="yes">
        <meta name="theme-color" content="#000000">
        <title>${ pageTitle }</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootswatch/5.2.3/zephyr/bootstrap.min.css" />
        <style type="text/css">
            .pt-8 { padding-top: 110px }
            .frappe-chart .x.axis text { display: none }
            .chart .chart-container { padding-top: 15px; }
            text.title { font-size: 90%; font-weight: bolder; }
        </style>
    </head>
    <body>
        <div class="container" style="margin-top: 30px;">
            <h2 class="text-center">${ pageTitle }</h2>
            <br>
            <div class="charts"></div>
        </div>
        <script src="https://code.jquery.com/jquery-3.3.1.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/frappe-charts@1.6.2/dist/frappe-charts.min.umd.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.24.0/moment.min.js"></script>
        <script>
            function segmentToTs(t) { return 3e5 * t; }
            
            function tsToSegment(t) { return (t = t || +new Date()), Math.floor(t / 3e5); }
            
            var status_codes = {
                "100": "Continue",
                "101": "Switching Protocols",
                "102": "Processing",
                "103": "Checkpoint",
                "200": "OK",
                "201": "Created",
                "202": "Accepted",
                "203": "Non-Authoritative Information",
                "204": "No Content",
                "205": "Reset Content",
                "206": "Partial Content",
                "207": "Multi-Status",
                "208": "Already Reported",
                "300": "Multiple Choices",
                "301": "Moved Permanently",
                "302": "Found",
                "303": "See Other",
                "304": "Not Modified",
                "305": "Use Proxy",
                "306": "Switch Proxy",
                "307": "Temporary Redirect",
                "308": "Permanent Redirect",
                "400": "Bad Request",
                "401": "Unauthorized",
                "402": "Payment Required",
                "403": "Forbidden",
                "404": "Not Found",
                "405": "Method Not Allowed",
                "406": "Not Acceptable",
                "407": "Proxy Authentication Required",
                "408": "Request Time-out",
                "409": "Conflict",
                "410": "Gone",
                "411": "Length Required",
                "412": "Precondition Failed",
                "413": "Request Entity Too Large",
                "414": "Request-URI Too Long",
                "415": "Unsupported Media Type",
                "416": "Requested Range Not Satisfiable",
                "417": "Expectation Failed",
                "418": "I'm a teapot",
                "421": "Unprocessable Entity",
                "422": "Misdirected Request",
                "423": "Locked",
                "424": "Failed Dependency",
                "426": "Upgrade Required",
                "428": "Precondition Required",
                "429": "Too Many Requests",
                "431": "Request Header Fileds Too Large",
                "451": "Unavailable For Legal Reasons",
                "500": "Internal Server Error",
                "501": "Not Implemented",
                "502": "Bad Gateway",
                "503": "Service Unavailable",
                "504": "Gateway Timeout",
                "505": "HTTP Version Not Supported",
                "506": "Variant Also Negotiates",
                "507": "Insufficient Storage",
                "508": "Loop Detected",
                "509": "Bandwidth Limit Exceeded",
                "510": "Not Extended",
                "511": "Network Authentication Required",
                "1xx": "Informational",
                "2xx": "Success",
                "3xx": "Redirection",
                "4xx": "Client Error",
                "5xx": "Server Error"
            };
            
            function statusCodeString(x) {
                var y = status_codes[(x+'')];
                return y ? ' (' + ( y ) + ')' : '';
            }
            
            function renderChart(t, a) {
                var r = $('<div class="row"> <div class="col-md-12">  <div class="card bg-light mb-3"> <div class="chart" title=""></div> <div class="chart2" title=""></div> </div>  </div>    </div>'); //<div class="col-md-1 align-middle pt-8"><strong class="reqs"></strong><strong> reqs.</strong> </div>
                
                r.attr('data-k', t); // r.find('.reqs').text(a.count), , r.find('.adur').text(Math.round(a.avgDurationMs)),
                
                var nsStr = '';
                
                for (var _k in a.namespaces) {
                    var space = a.namespaces[_k];
                    
                    if (Object.keys(space).length) {
                        nsStr += (_k + ': ');
                        
                        var keys = [];
                        for (var __k in space) { keys.push(__k) }
                        
                        nsStr += keys.join(', ') + ' ';
                    }
                }
                
                r.find('.chart').attr('title', nsStr);
                
                for (var e = { labels: [], datasets: [] }, f = { labels: [], datasets: [] }, s = tsToSegment(), n = s - 23, o = n; o <= s; o++) {
                    var i = moment(segmentToTs(o)).fromNow();
                    e.labels.push(i);
                    f.labels.push(i);
                }
                
                for (var d in a.statusCodes) {
                    var c = { name: d, chartType: "bar", values: [] };
                    var g = { name: d, chartType: "line", values: [] };
                    for (o = n; o <= s; o++) {
                        var l = 0, m = 0;
                        try {
                            l = a.statusCodes[d].segments[o].count;
                            m = a.statusCodes[d].segments[o].avgDurationMs;
                        } catch (t) {}
                        c.values.push(l);
                        g.values.push(Math.round(m));
                    }
                    e.datasets.push(c);
                    f.datasets.push(g);
                }
                
                $(".container > .charts").append(r);
                
                new frappe.Chart(r.find(".chart")[0], {
                    data: e,
                    title: t + (nsStr ? (' - ' + nsStr) : ''),
                    type: "bar",
                    height: 220,
                    colors: ["green"],
                    barOptions: { stacked: !0, spaceRatio: 0.2 },
                    animate: false,
                    truncateLegends: true,
                    xAxisMode: 'tick',
                    tooltipOptions: {
                        formatTooltipX: function (t) {
                            return (t + "").toUpperCase();
                        },
                        formatTooltipY: function (t) {
                            return (t || 0).toLocaleString() + " req(s)";
                        },
                    },
                });
                
                new frappe.Chart(r.find(".chart2")[0], {
                    data: f,
                    title: 'Average Request Times (' + (Math.round(a.avgDurationMs || 0)).toLocaleString() + 'ms Average over ' + (a.count || 0).toLocaleString() + ' requests)',
                    type: "line",
                    height: 220,
                    colors: ["green"],
                    barOptions: {  },
                    animate: false,
                    truncateLegends: true,
                    xAxisMode: 'tick',
                    tooltipOptions: {
                        formatTooltipX: function (t) {
                            return (t + "").toUpperCase();
                        },
                        formatTooltipY: function (t) {
                            return (t || 0).toLocaleString() + "ms";
                        },
                    },
                });
            }
            
            function getData() {
                $.get('/slamCounts', function (t) {
                    window._data = t;
                    
                    for (var a in (t && $('.container > .charts').html(''), t)) {
                        renderChart(a, t[a]);
                    }
                });
            }
            
            $(document).ready(function () { setInterval(getData, 12e4), getData() });
        </script>
    </body>
</html>
`);

    });
};

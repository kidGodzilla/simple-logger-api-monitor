/**
 * Simple Logger / API Monitor (SLAM) for Express
 */
module.exports = function (app) {
    const process = require('process');
    const os = require('os');
    const v8 = require('v8');

    // Helper functions (moved to top level)
    // Javascript timestamp to compressed segment
    function tsToSegment (ts) {
        if (!ts) ts = + new Date();
        return Math.floor(ts / (1000 * 60 * 5));
    }

    // Compressed segment to Javascript timestamp
    function segmentToTs (seg) {
        return seg * (1000 * 60 * 5);
    }

    // Initialize system metrics storage
    if (!global.slamSystemMetrics) {
        global.slamSystemMetrics = {
            memory: {},
            cpu: {},
            lastCpuUsage: process.cpuUsage()
        };
    }

    // Function to collect system metrics
    function collectSystemMetrics() {
        const timeSegment = tsToSegment();
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        
        // Calculate CPU percentage since last measurement
        const cpuPercent = global.slamSystemMetrics.lastCpuUsage ? 
            ((cpuUsage.user - global.slamSystemMetrics.lastCpuUsage.user) + 
             (cpuUsage.system - global.slamSystemMetrics.lastCpuUsage.system)) / 1000000 : 0;
        
        global.slamSystemMetrics.lastCpuUsage = cpuUsage;

        // Store memory metrics
        if (!global.slamSystemMetrics.memory[timeSegment]) {
            global.slamSystemMetrics.memory[timeSegment] = {
                rss: memUsage.rss,
                heapUsed: memUsage.heapUsed,
                heapTotal: memUsage.heapTotal,
                external: memUsage.external,
                arrayBuffers: memUsage.arrayBuffers || 0,
                timestamp: Date.now()
            };
        }

        // Store CPU metrics
        if (!global.slamSystemMetrics.cpu[timeSegment]) {
            global.slamSystemMetrics.cpu[timeSegment] = {
                user: cpuUsage.user,
                system: cpuUsage.system,
                percent: cpuPercent,
                loadAverage: os.loadavg(),
                timestamp: Date.now()
            };
        }

        // Cleanup old segments (older than 2 hours)
        const minSegment = timeSegment - 23;
        Object.keys(global.slamSystemMetrics.memory).forEach(seg => {
            if (parseInt(seg) < minSegment) {
                delete global.slamSystemMetrics.memory[seg];
            }
        });
        Object.keys(global.slamSystemMetrics.cpu).forEach(seg => {
            if (parseInt(seg) < minSegment) {
                delete global.slamSystemMetrics.cpu[seg];
            }
        });
    }

    // Middleware
    app.use(function (req, res, next) {
        if (!global.slamCounts) global.slamCounts = {}; // Create if not exists

        try {
            // Setup
            const time = process.hrtime();
            const NS_PER_SEC = 1e9;
            const NS_TO_MS = 1e6;

            // Environment Variables
            const log_long_requests = process.env.SLAM_LOG_LONG_REQUESTS !== 'false';
            const console_logging_enabled = process.env.SLAM_DEBUG ==='true';
            const long_req = process.env.SLAM_MAX_REQUEST_LENGTH || 5000;

            // Collect system metrics on each request
            collectSystemMetrics();

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
            console.log('[Slam exception]', e);
            next()
        }

    });

    // Return the raw counts and stats (Now sorted in a non-compliant way)
    app.get('/slamCounts', function (req, res) {
        let counts = global.slamCounts;

        // Convert object to array of objects
        const arr = Object.entries(counts).map(([key, value]) => ({ key, ...value }));
        arr.sort((a, b) => b.count - a.count);

        let sortedObject = {};

        arr.forEach(o => {
            sortedObject[o.key] = o;
        });

        res.json(sortedObject);
    });

    // Return system metrics (memory and CPU)
    app.get('/slamSystemMetrics', function (req, res) {
        const metrics = global.slamSystemMetrics || { memory: {}, cpu: {} };
        
        // Get current system info
        const currentMemory = process.memoryUsage();
        const currentCpu = process.cpuUsage();
        const loadAvg = os.loadavg();
        
        // Calculate memory usage percentages and trends
        const memoryTrend = Object.keys(metrics.memory).sort().slice(-5).map(seg => ({
            segment: parseInt(seg),
            timestamp: metrics.memory[seg].timestamp,
            rss: Math.round(metrics.memory[seg].rss / 1024 / 1024), // MB
            heapUsed: Math.round(metrics.memory[seg].heapUsed / 1024 / 1024), // MB
            heapTotal: Math.round(metrics.memory[seg].heapTotal / 1024 / 1024), // MB
            external: Math.round(metrics.memory[seg].external / 1024 / 1024), // MB
        }));

        const cpuTrend = Object.keys(metrics.cpu).sort().slice(-5).map(seg => ({
            segment: parseInt(seg),
            timestamp: metrics.cpu[seg].timestamp,
            userTime: Math.round(metrics.cpu[seg].user / 1000), // ms
            systemTime: Math.round(metrics.cpu[seg].system / 1000), // ms
            percent: Math.round(metrics.cpu[seg].percent * 100) / 100,
            loadAverage: metrics.cpu[seg].loadAverage
        }));

        res.json({
            current: {
                memory: {
                    rss: Math.round(currentMemory.rss / 1024 / 1024), // MB
                    heapUsed: Math.round(currentMemory.heapUsed / 1024 / 1024), // MB
                    heapTotal: Math.round(currentMemory.heapTotal / 1024 / 1024), // MB
                    external: Math.round(currentMemory.external / 1024 / 1024), // MB
                    heapUtilization: Math.round((currentMemory.heapUsed / currentMemory.heapTotal) * 100)
                },
                cpu: {
                    userTime: Math.round(currentCpu.user / 1000), // ms
                    systemTime: Math.round(currentCpu.system / 1000), // ms
                    loadAverage: loadAvg,
                    cores: os.cpus().length
                },
                system: {
                    uptime: Math.round(process.uptime()),
                    platform: os.platform(),
                    arch: os.arch(),
                    nodeVersion: process.version,
                    hostname: os.hostname()
                }
            },
            trends: {
                memory: memoryTrend,
                cpu: cpuTrend
            },
            segments: {
                memory: metrics.memory,
                cpu: metrics.cpu
            }
        });
    });

    // Combined health endpoint
    app.get('/slamHealth', function (req, res) {
        const apiCounts = global.slamCounts || {};
        const systemMetrics = global.slamSystemMetrics || { memory: {}, cpu: {} };
        
        // Calculate total requests and average response time
        let totalRequests = 0;
        let totalDuration = 0;
        let errorCount = 0;
        
        Object.values(apiCounts).forEach(route => {
            totalRequests += route.count;
            totalDuration += route.avgDurationMs * route.count;
            
            Object.keys(route.statusCodes).forEach(statusCode => {
                if (statusCode >= 400) {
                    errorCount += route.statusCodes[statusCode].count;
                }
            });
        });

        const avgResponseTime = totalRequests > 0 ? totalDuration / totalRequests : 0;
        const errorRate = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;

        // Get latest system metrics
        const currentMemory = process.memoryUsage();
        const loadAvg = os.loadavg();

        // Calculate memory pressure based on actual V8 heap limits
        const heapStats = v8.getHeapStatistics();
        const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);
        const rssMB = Math.round(currentMemory.rss / 1024 / 1024);
        const heapUsedMB = Math.round(currentMemory.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(currentMemory.heapTotal / 1024 / 1024);
        const heapUtilization = Math.round((currentMemory.heapUsed / currentMemory.heapTotal) * 100);
        
        // Memory pressure indicators:
        // 1. RSS > 80% of heap limit (approaching V8's memory limit)
        // 2. Heap used > 75% of heap limit (getting close to V8 limit)
        // 3. RSS growth trend (if we have historical data)
        const rssThreshold = heapLimitMB * 0.8;
        const heapUsedThreshold = heapLimitMB * 0.75;
        const highMemoryUsage = rssMB > rssThreshold || heapUsedMB > heapUsedThreshold;
        
        // Check for memory growth trend
        let memoryGrowthConcern = false;
        const recentMemorySegments = Object.keys(systemMetrics.memory || {})
            .sort()
            .slice(-5)
            .map(seg => systemMetrics.memory[seg]);
            
        if (recentMemorySegments.length >= 3) {
            const oldestRss = recentMemorySegments[0].rss / 1024 / 1024;
            const newestRss = recentMemorySegments[recentMemorySegments.length - 1].rss / 1024 / 1024;
            // If memory has grown by more than 50% in recent segments, flag it
            memoryGrowthConcern = (newestRss / oldestRss) > 1.5;
        }

        const memoryPressure = highMemoryUsage || memoryGrowthConcern;
        const highErrorRate = errorRate > 5;
        const highLoad = loadAvg[0] > os.cpus().length;

        res.json({
            timestamp: Date.now(),
            api: {
                totalRequests,
                avgResponseTime: Math.round(avgResponseTime),
                errorRate: Math.round(errorRate * 100) / 100,
                errorCount,
                routeCount: Object.keys(apiCounts).length
            },
            system: {
                memory: {
                    heapUsed: heapUsedMB,
                    heapTotal: heapTotalMB,
                    heapUtilization: heapUtilization,
                    rss: rssMB,
                    heapLimit: heapLimitMB,
                    // Add more context for memory assessment
                    memoryPressureReason: memoryPressure ? 
                        (rssMB > rssThreshold ? `High RSS usage (${rssMB}MB > ${Math.round(rssThreshold)}MB limit)` : 
                         heapUsedMB > heapUsedThreshold ? `High heap usage (${heapUsedMB}MB > ${Math.round(heapUsedThreshold)}MB limit)` :
                         memoryGrowthConcern ? 'Memory growth detected' : 
                         'Memory pressure detected') : null
                },
                cpu: {
                    loadAverage: loadAvg,
                    cores: os.cpus().length
                },
                uptime: Math.round(process.uptime())
            },
            health: {
                status: (errorRate > 10 || memoryPressure || highLoad) ? 'warning' : 'healthy',
                memoryPressure: memoryPressure,
                highErrorRate: highErrorRate,
                highLoad: highLoad,
                // Add more detailed health info
                details: {
                    memoryStatus: rssMB > rssThreshold ? 'high' : rssMB > (rssThreshold * 0.6) ? 'moderate' : 'normal',
                    memoryTrend: memoryGrowthConcern ? 'growing' : 'stable',
                    heapLimitMB: heapLimitMB,
                    thresholds: {
                        rssWarning: Math.round(rssThreshold),
                        heapWarning: Math.round(heapUsedThreshold)
                    }
                }
            }
        });
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
            .health-status { 
                padding: 15px; 
                border-radius: 8px; 
                margin-bottom: 20px; 
                border-left: 4px solid;
            }
            .health-healthy { 
                background-color: #d4edda; 
                border-color: #28a745; 
                color: #155724; 
            }
            .health-warning { 
                background-color: #fff3cd; 
                border-color: #ffc107; 
                color: #856404; 
            }
            .health-critical { 
                background-color: #f8d7da; 
                border-color: #dc3545; 
                color: #721c24; 
            }
            .metric-card {
                background: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 8px;
                padding: 15px;
                margin-bottom: 15px;
            }
            .metric-value {
                font-size: 1.5em;
                font-weight: bold;
                color: #495057;
            }
            .metric-label {
                font-size: 0.9em;
                color: #6c757d;
                margin-bottom: 5px;
            }
            .system-charts {
                margin-bottom: 30px;
            }
        </style>
    </head>
    <body>
        <div class="container" style="margin-top: 30px;">
            <h2 class="text-center">${ pageTitle }</h2>
            <br>
            
            <!-- System Health Status -->
            <div id="health-status" class="health-status health-healthy">
                <div class="row">
                    <div class="col-md-8">
                        <h5 id="health-title">System Status: <span id="health-text">Loading...</span></h5>
                        <p id="health-details" class="mb-0">Checking system health...</p>
                    </div>
                    <div class="col-md-4 text-end">
                        <small id="last-updated" class="text-muted">Last updated: --</small>
                    </div>
                </div>
            </div>

            <!-- System Metrics Overview -->
            <div class="row system-charts">
                <div class="col-md-3">
                    <div class="metric-card text-center">
                        <div class="metric-label">Memory Usage</div>
                        <div class="metric-value" id="memory-usage">--</div>
                        <small class="text-muted" id="memory-details">-- MB / -- MB</small>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="metric-card text-center">
                        <div class="metric-label">CPU Load</div>
                        <div class="metric-value" id="cpu-load">--</div>
                        <small class="text-muted" id="cpu-details">-- cores</small>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="metric-card text-center">
                        <div class="metric-label">API Requests</div>
                        <div class="metric-value" id="total-requests">--</div>
                        <small class="text-muted" id="avg-response">-- ms avg</small>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="metric-card text-center">
                        <div class="metric-label">Error Rate</div>
                        <div class="metric-value" id="error-rate">--%</div>
                        <small class="text-muted" id="uptime">Uptime: --</small>
                    </div>
                </div>
            </div>

            <!-- System Charts -->
            <div class="row system-charts">
                <div class="col-md-6">
                    <div class="card bg-light mb-3">
                        <div class="card-header">Memory Usage Trend</div>
                        <div id="memory-chart"></div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="card bg-light mb-3">
                        <div class="card-header">CPU Load Trend</div>
                        <div id="cpu-chart"></div>
                    </div>
                </div>
            </div>

            <h4>API Endpoint Metrics</h4>
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
            
            function formatUptime(seconds) {
                const days = Math.floor(seconds / 86400);
                const hours = Math.floor((seconds % 86400) / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                
                if (days > 0) return days + 'd ' + hours + 'h';
                if (hours > 0) return hours + 'h ' + minutes + 'm';
                return minutes + 'm';
            }

            function updateSystemMetrics() {
                $.get('/slamHealth', function (health) {
                    // Update health status
                    const statusEl = $('#health-status');
                    const statusText = $('#health-text');
                    const statusDetails = $('#health-details');
                    
                    statusEl.removeClass('health-healthy health-warning health-critical');
                    
                    if (health.health.status === 'healthy') {
                        statusEl.addClass('health-healthy');
                        statusText.text('Healthy');
                        statusDetails.text('All systems operating normally');
                    } else {
                        statusEl.addClass('health-warning');
                        statusText.text('Warning');
                        let issues = [];
                        if (health.health.memoryPressure) {
                            const reason = health.system.memory.memoryPressureReason || 'High memory usage';
                            issues.push(reason);
                        }
                        if (health.health.highErrorRate) issues.push('High error rate');
                        if (health.health.highLoad) issues.push('High CPU load');
                        statusDetails.text('Issues detected: ' + issues.join(', '));
                    }
                    
                    // Update metric cards - show RSS instead of heap percentage for more meaningful info
                    $('#memory-usage').text(health.system.memory.rss + ' MB');
                    $('#memory-details').text('RSS: ' + health.system.memory.rss + ' MB, Limit: ' + health.system.memory.heapLimit + ' MB');
                    
                    $('#cpu-load').text(health.system.cpu.loadAverage[0].toFixed(2));
                    $('#cpu-details').text(health.system.cpu.cores + ' cores');
                    
                    $('#total-requests').text(health.api.totalRequests.toLocaleString());
                    $('#avg-response').text(health.api.avgResponseTime + ' ms avg');
                    
                    $('#error-rate').text(health.api.errorRate + '%');
                    $('#uptime').text('Uptime: ' + formatUptime(health.system.uptime));
                    
                    $('#last-updated').text('Last updated: ' + moment().format('HH:mm:ss'));
                });

                $.get('/slamSystemMetrics', function (metrics) {
                    // Render memory chart
                    if (metrics.trends.memory.length > 0) {
                        const memoryData = {
                            labels: metrics.trends.memory.map(m => moment(m.timestamp).fromNow()),
                            datasets: [
                                {
                                    name: "Heap Used",
                                    chartType: "line",
                                    values: metrics.trends.memory.map(m => m.heapUsed)
                                },
                                {
                                    name: "RSS",
                                    chartType: "line", 
                                    values: metrics.trends.memory.map(m => m.rss)
                                }
                            ]
                        };

                        new frappe.Chart("#memory-chart", {
                            data: memoryData,
                            type: "line",
                            height: 200,
                            colors: ["#007bff", "#28a745"],
                            animate: false,
                            tooltipOptions: {
                                formatTooltipY: function (value) {
                                    return value + " MB";
                                }
                            }
                        });
                    }

                    // Render CPU chart
                    if (metrics.trends.cpu.length > 0) {
                        const cpuData = {
                            labels: metrics.trends.cpu.map(c => moment(c.timestamp).fromNow()),
                            datasets: [
                                {
                                    name: "Load Average",
                                    chartType: "line",
                                    values: metrics.trends.cpu.map(c => c.loadAverage[0].toFixed(2))
                                }
                            ]
                        };

                        new frappe.Chart("#cpu-chart", {
                            data: cpuData,
                            type: "line",
                            height: 200,
                            colors: ["#ffc107"],
                            animate: false,
                            tooltipOptions: {
                                formatTooltipY: function (value) {
                                    return value + " load";
                                }
                            }
                        });
                    }
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
            
            $(document).ready(function () { 
                // Update both system metrics and API data
                function updateAll() {
                    updateSystemMetrics();
                    getData();
                }
                
                // Update every 2 minutes
                setInterval(updateAll, 12e4);
                
                // Initial load
                updateAll();
            });
        </script>
    </body>
</html>
`);

    });
};

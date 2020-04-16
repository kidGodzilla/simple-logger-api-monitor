# 📈 Simple Logger / API Monitor (SLAM) for Express

Add an API monitoring page to your Express app in 3 seconds. Visualizes requests over time, with average response times and error rates.

![SLAM](https://cdn.jsdelivr.net/gh/kidGodzilla/simple-logger-api-monitor/slam.webp)

## Installation

```
npm i -s simple-logger-api-monitor
```


## Setup

Add the following line before your Express routes (ensuring you pass your app to this module):

```
require('simple-logger-api-monitor')(app);
```

This will add a new global, `global.slamCounts`, and two new routes: `GET /slamCounts` & `GET /monitor`. Additionally, a middleware will track each request, and log statistics about each request. Overhead should not be noticeable, even with heavy traffic.


## Usage

You do not need to monitor your app to use this page. Simply visit the `/monitor` route of your application to view usage statistics for your app API routes. Detailed statistics are kept for 2 hours. Data is purged each time your app restarts. Clustering is supported.


## Issues

The intent is for this to remain very simple and easy to use, so the scope of features is intentionally small.

However, If you run in to any issues feel free to open an issue.


## Contributing

Contributions welcome! Please open an Issue before creating a pull request.

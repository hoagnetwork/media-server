const Fs = require('fs');
const path = require('path');
const Http = require('http');
const Https = require('https');
const WebSocket = require('ws');
const Express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth-connect');
const CryptoJS = require("crypto-js");
const NodeFlvSession = require('../sessions/flv_session');
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const HTTP_MEDIAROOT = './media';
const Logger = global.Logger;
const auth = require('../middleware/auth');
const context = require('../core/ctx');
const ip = require("ip");
const cors = require("cors");
const YAML = require('yamljs');
const swaggerDocument = YAML.load(global.BasePath + '/api-docs/api-swagger.yaml');
const swaggerUi = require('swagger-ui-express');
const streamsRoute = require('../api/routes/streams');
const streamsPrivateRoute = require('../api/routes/private/streams');
const serverRoute = require('../api/routes/server');
const relayRoute = require('../api/routes/relay');

class NodeHttpServer {
  constructor(config) {
    this.port = config.http.port || HTTP_PORT;
    this.mediaroot = config.http.mediaroot || HTTP_MEDIAROOT;
    this.config = config;

    if(this.config.cdn_url === false){
      this.config.cdn_url = "http://"+ip.address();
    }
    if(this.config.rtmp_url === false){
      this.config.rtmp_url = "rtmp://"+ip.address();
    }

    let app = Express();
    const corsOptions ={
        origin:'*', 
        credentials:true,            //access-control-allow-credentials:true
        optionSuccessStatus:200,
    }
    app.use(bodyParser.json());

    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(cors(corsOptions)) // Use this after the variable declaration
    app.engine('html', require('ejs').renderFile);
    app.set('view engine', 'html');
    app.set('views', __dirname);

    app.all('*.ts', (req, res, next) => {
      res.header("Access-Control-Allow-Origin", this.config.http.allow_origin);
      res.header("Access-Control-Allow-Headers", "Content-Length,Authorization,Accept,DNT,X-Mx-ReqToken,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range");
      res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.header("Access-Control-Allow-Credentials", true);
      res.header("Cache-Control", "public,max-age=5m,s-maxage=5m");
      req.method === "OPTIONS" ? res.sendStatus(200) : next();
    });

    app.get('*.m3u8', (req, res, next) => {
      res.header("Access-Control-Allow-Origin", this.config.http.allow_origin);
      res.header("Access-Control-Allow-Headers", "Content-Length,Authorization,Accept,DNT,X-Mx-ReqToken,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range");
      res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
      res.header("Access-Control-Allow-Credentials", true);
      res.header("Cache-Control", "public,max-age=5s,s-maxage=5s");
      req.method === "OPTIONS" ? res.sendStatus(200) : next();
    });

    app.get('*.flv', (req, res, next) => {
      req.nmsConnectionType = 'http';
      this.onConnect(req, res);
    });

    app.post('/api/v1/public/login', auth.login);

    app.get('/v/:id', (req, res) => {
      res.render("../views/channel.html", {name:req.params.id,cdn_url:this.config.cdn_url});
    });

    if (this.config.http.api !== false) {
      if (this.config.auth && this.config.auth.api) {
        app.use(['/api/v1/private/*'], auth.verifyToken);
      }
      app.use('/api/v1/public/streams', streamsRoute(context));
      app.use('/api/v1/private/streams', streamsPrivateRoute(context));
      app.use('/api/v1/private/server', serverRoute(context));
      app.use('/api/v1/private/relay', relayRoute(context));
      app.use('/api/v1/docs/', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
    }

    app.use(Express.static(path.join(__dirname + '/public')));
    app.use(Express.static(this.mediaroot));
    if (config.http.webroot) {
      app.use(Express.static(config.http.webroot));
    }

    this.httpServer = Http.createServer(app);

    /**
     * ~ openssl genrsa -out privatekey.pem 1024
     * ~ openssl req -new -key privatekey.pem -out certrequest.csr
     * ~ openssl x509 -req -in certrequest.csr -signkey privatekey.pem -out certificate.pem
     */
    if (this.config.https) {
      let options = {
        key: Fs.readFileSync(this.config.https.key),
        cert: Fs.readFileSync(this.config.https.cert)
      };
      this.sport = config.https.port ? config.https.port : HTTPS_PORT;
      this.httpsServer = Https.createServer(options, app);
    }
  }

  run() {
    this.httpServer.listen(this.port, () => {
      Logger.log(`Media Server - Http Server started on port: ${this.port}`);
    });

    this.httpServer.on('error', (e) => {
      Logger.error(`Media Server - Http Server ${e}`);
    });

    this.httpServer.on('close', () => {
      Logger.log('Media Server - Http Server Close.');
    });

    this.wsServer = new WebSocket.Server({ server: this.httpServer });

    this.wsServer.on('connection', (ws, req) => {
      req.nmsConnectionType = 'ws';
      this.onConnect(req, ws);
    });

    this.wsServer.on('listening', () => {
      Logger.log(`Media Server - WebSocket Server started on port: ${this.port}`);
    });
    this.wsServer.on('error', (e) => {
      Logger.error(`Media Server - WebSocket Server ${e}`);
    });

    if (this.httpsServer) {
      this.httpsServer.listen(this.sport, () => {
        Logger.log(`Media Server - Https Server started on port: ${this.sport}`);
      });

      this.httpsServer.on('error', (e) => {
        Logger.error(`Media Server - Https Server ${e}`);
      });

      this.httpsServer.on('close', () => {
        Logger.log('Media Server - Https Server Close.');
      });

      this.wssServer = new WebSocket.Server({ server: this.httpsServer });

      this.wssServer.on('connection', (ws, req) => {
        req.nmsConnectionType = 'ws';
        this.onConnect(req, ws);
      });

      this.wssServer.on('listening', () => {
        Logger.log(`Media Server - WebSocketSecure Server started on port: ${this.sport}`);
      });
      this.wssServer.on('error', (e) => {
        Logger.error(`Media Server - WebSocketSecure Server ${e}`);
      });
    }

    context.nodeEvent.on('postPlay', (id, args) => {
      context.stat.accepted++;
    });

    context.nodeEvent.on('postPublish', (id, args) => {
      context.stat.accepted++;
    });

    context.nodeEvent.on('doneConnect', (id, args) => {
      let session = context.sessions.get(id);
      let socket = session instanceof NodeFlvSession ? session.req.socket : session.socket;
      context.stat.inbytes += socket.bytesRead;
      context.stat.outbytes += socket.bytesWritten;
    });
  }

  stop() {
    this.httpServer.close();
    if (this.httpsServer) {
      this.httpsServer.close();
    }
    context.sessions.forEach((session, id) => {
      if (session instanceof NodeFlvSession) {
        session.req.destroy();
        context.sessions.delete(id);
      }
    });
  }

  onConnect(req, res) {
    let session = new NodeFlvSession(this.config, req, res);
    session.run();

  }
}

module.exports = NodeHttpServer;

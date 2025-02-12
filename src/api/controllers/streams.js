const _ = require("lodash");
const NodeTransServer = require("../../servers/trans_server");
const CryptoJS = require("crypto-js");

function postStreamTrans(req, res, next) {
  let config = req.body;
  if (
    config.app &&
    config.hls &&
    config.ac &&
    config.vc &&
    config.hlsFlags &&
    config.dash &&
    config.dashFlags
  ) {
    transServer = new NodeTransServer(config);
    console.log(req.body);
    if (transServer) {
      res.json({ message: "OK Success" });
    } else {
      res.status(404);
      res.json({ message: "Failed creating stream" });
    }
  } else {
    res.status(404);
    res.json({ message: "Failed creating stream" });
  }
}

function genStreams(req, res, next) {
  res.header("Cache-Control", "no-store, max-age=0");
  var name = '';
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < 8; i++ ) {
    name += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  var md5 = CryptoJS.SHA256(global.gConfig.passphrase+"/live/"+name).toString();
  var key = name+"?pwd="+md5.substring(0,6);

  res.json({name:name, key:key, rtmp_url:global.gConfig.rtmp_url+"/live/", cdn_url:global.gConfig.cdn_url });
}

function getStreams(req, res, next) {
  let stats = {};

  this.sessions.forEach(function(session, id) {
    if (session.isStarting) {
      let regRes = /\/(.*)\/(.*)/gi.exec(
        session.publishStreamPath || session.playStreamPath
      );

      if (regRes === null) return;

      let [app, stream] = _.slice(regRes, 1);

      if (!_.get(stats, [app, stream])) {
        _.setWith(stats, [app, stream], {
          publisher: null,
          subscribers: []
        }, Object);
      }

      switch (true) {
        case session.isPublishing: {
          _.setWith(stats, [app, stream, 'publisher'], {
            app: app,
            stream: stream,
            clientId: session.id,
            connectCreated: session.connectTime,
            bytes: session.socket.bytesRead,
            ip: session.socket.remoteAddress,
            audio: session.audioCodec > 0 ? {
              codec: session.audioCodecName,
              profile: session.audioProfileName,
              samplerate: session.audioSamplerate,
              channels: session.audioChannels
            } : null,
            video: session.videoCodec > 0 ? {
              codec: session.videoCodecName,
              width: session.videoWidth,
              height: session.videoHeight,
              profile: session.videoProfileName,
              level: session.videoLevel,
              fps: session.videoFps
            } : null,
          },Object);
          break;
        }
        case !!session.playStreamPath: {
          switch (session.constructor.name) {
            case "NodeRtmpSession": {
              stats[app][stream]["subscribers"].push({
                app: app,
                stream: stream,
                clientId: session.id,
                connectCreated: session.connectTime,
                bytes: session.socket.bytesWritten,
                ip: session.socket.remoteAddress,
                protocol: "rtmp"
              });

              break;
            }
            case "NodeFlvSession": {
              stats[app][stream]["subscribers"].push({
                app: app,
                stream: stream,
                clientId: session.id,
                connectCreated: session.connectTime,
                bytes: session.req.connection.bytesWritten,
                ip: session.req.connection.remoteAddress,
                protocol: session.TAG === "websocket-flv" ? "ws" : "http"
              });

              break;
            }
          }

          break;
        }
      }
    }
  });
  res.json(stats);
}

function getStream(req, res, next) {
  let streamStats = {
    isLive: false,
    viewers: 0,
    duration: 0,
    bitrate: 0,
    startTime: null
  };

  let publishStreamPath = `/${req.params.app}/${req.params.stream}`;

  let publisherSession = this.sessions.get(
    this.publishers.get(publishStreamPath)
  );

  streamStats.isLive = !!publisherSession;
  streamStats.viewers = _.filter(
    Array.from(this.sessions.values()),
    session => {
      return session.playStreamPath === publishStreamPath;
    }
  ).length;
  streamStats.duration = streamStats.isLive
    ? Math.ceil((Date.now() - publisherSession.startTimestamp) / 1000)
    : 0;
  streamStats.bitrate =
    streamStats.duration > 0
      ? Math.ceil(
          (_.get(publisherSession, ["socket", "bytesRead"], 0) * 8) /
            streamStats.duration /
            1024
        )
      : 0;
  streamStats.startTime = streamStats.isLive
    ? publisherSession.connectTime
    : null;

  res.json(streamStats);
}

function delStream(req, res, next) {
  let publishStreamPath = `/${req.params.app}/${req.params.stream}`;
  let publisherSession = this.sessions.get(
    this.publishers.get(publishStreamPath)
  );

  if (publisherSession) {
    publisherSession.stop();
    res.json("ok");
  } else {
    res.json({ error: "stream not found" }, 404);
  }
}

exports.genStreams = genStreams;
exports.delStream = delStream;
exports.getStreams = getStreams;
exports.getStream = getStream;
exports.postStreamTrans = postStreamTrans;

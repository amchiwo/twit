var assert = require('assert');
var fs = require('fs');
var mime = require('mime');
var util = require('util');

var MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
var MAX_VIDEO_SIZE_BYTES = 512 * 1024 * 1024;
var MAX_FILE_CHUNK_BYTES = 5 * 1024 * 1024;

/**
 * FileUploader class used to upload a file to twitter via the /media/upload (chunked) API.
 * Usage:
 *   var fu = new FileUploader({ file_path: '/foo/bar/baz.mp4' }, twit);
 *   fu.upload(function (err, bodyObj, resp) {
 *     console.log(err, bodyObj);
 *   })
 *
 * @param  {Object}         params  Object of the form { file_path: String }.
 * @param  {Twit(object)}   twit    Twit instance.
 */
var FileUploader = function (params, twit) {
  assert(params)
  assert(params.file_path, 'Must specify `file_path` to upload a file. Got: ' + params.file_path + '.')
  var self = this;
  self._file_path = params.file_path;
  self._twit = twit;
  self._isUploading = false;
  self._isFileStreamEnded = false;
}

/**
 * Upload a file to Twitter via the /media/upload (chunked) API.
 *
 * @param  {Function} cb function (err, data, resp)
 */
FileUploader.prototype.upload = function (cb) {
  var self = this;

  // Send INIT command with file info and get back a media_id_string we can use to APPEND chunks to it.
  self._initMedia(function (err, bodyObj, resp) {
    if (err) {
      cb(err);
      return;
    } else {
      var mediaTmpId = bodyObj.media_id_string;
      var chunkNumber = 0;
      var mediaFile = fs.createReadStream(self._file_path, { highWaterMark: MAX_FILE_CHUNK_BYTES });
      var checkAsyncFinish = function (err, bodyObj, resp) {
        if (err) {
            cb(err);
            return;
        } else {
            console.log ('checking async finish', bodyObj);
            if (bodyObj.processing_info) {
                var checkStatus = function () {
                    self._statusMedia(mediaTmpId, function (err, bodyObj, resp) {
                        if (err) {
                            cb(err);
                            return;
                        } else {
                            switch (bodyObj.processing_info.state) {
                                case 'in_progress':
                                    var waitTime = bodyObj.processing_info.check_after_secs;
                                    console.log(bodyObj.processing_info.progress_percent, '%');
                                    if (!waitTime) waitTime = 3;
                                    setTimeout(checkStatus, waitTime * 1000);
                                    break;
                                case 'failed':
                                    cb(new Error(bodyObj.processing_info.error.message));
                                    break;
                                case 'succeeded':
                                    cb(err, bodyObj, resp);
                            }
                        }
                    });
                };
                var waitTime = bodyObj.processing_info.check_after_secs;
                if (!waitTime) waitTime = 5;
                setTimeout(checkStatus, waitTime * 1000);
            } else {
                cb(err, bodyObj, resp);
            }
        }
      };

      mediaFile.on('data', function (chunk) {
        // Pause our file stream from emitting `data` events until the upload of this chunk completes.
        // Any data that becomes available will remain in the internal buffer.
        mediaFile.pause();
        self._isUploading = true;

        self._appendMedia(mediaTmpId, chunk.toString('base64'), chunkNumber, function (err, bodyObj, resp) {
          self._isUploading = false;
          if (err) {
            cb(err);
          } else {
            if (self._isUploadComplete()) {
              // We've hit the end of our stream; send FINALIZE command.
              self._finalizeMedia(mediaTmpId, checkAsyncFinish);
            } else {
              // Tell our file stream to start emitting `data` events again.
              chunkNumber++;
              mediaFile.resume();
            }
          }
        });
      });

      mediaFile.on('end', function () {
        // Mark our file streaming complete, and if done, send FINALIZE command.
        self._isFileStreamEnded = true;
        if (self._isUploadComplete()) {
          self._finalizeMedia(mediaTmpId, checkAsyncFinish);
        }
      });
    }
  })
}

FileUploader.prototype._isUploadComplete = function () {
  return !this._isUploading && this._isFileStreamEnded;
}

  /**
   * Send STATUS command for media object with id `media_id`.
   * Retrieves the async processing status for our mediaFile.
   *
   * @param  {String}   media_id
   * @param  {Function} cb
   */
FileUploader.prototype._statusMedia = function(media_id, cb) {
  var self = this;
  self._twit.get('media/upload', {
    command: 'STATUS',
    media_id: media_id
  }, cb);
}

  /**
   * Send FINALIZE command for media object with id `media_id`.
   *
   * @param  {String}   media_id
   * @param  {Function} cb
   */
FileUploader.prototype._finalizeMedia = function(media_id, cb) {
  var self = this;
  self._twit.post('media/upload', {
    command: 'FINALIZE',
    media_id: media_id
  }, cb);
}

  /**
   * Send APPEND command for media object with id `media_id`.
   * Append the chunk to the media object, then resume streaming our mediaFile.
   *
   * @param  {String}   media_id        media_id_string received from Twitter after sending INIT comand.
   * @param  {String}   chunk_part      Base64-encoded String chunk of the media file.
   * @param  {Number}   segment_index   Index of the segment.
   * @param  {Function} cb
   */
FileUploader.prototype._appendMedia = function(media_id_string, chunk_part, segment_index, cb) {
  var self = this;
  self._twit.post('media/upload', {
    command: 'APPEND',
    media_id: media_id_string.toString(),
    segment_index: segment_index,
    media: chunk_part,
  }, cb);
}

/**
 * Send INIT command for our underlying media object.
 *
 * @param  {Function} cb
 */
FileUploader.prototype._initMedia = function (cb) {
  var self = this;
  var mediaType = mime.lookup(self._file_path);
  var mediaFileSizeBytes = fs.statSync(self._file_path).size;
  var imageMime = ['image/png', 'image/jpeg', 'image/webp']; // MIME types assumed to be an image file
  var animatedGifMime = ['image/gif']; // MIME types assumed to be a GIF animation
  var videoMime = ['video/mp4']; // MIME types assumed to be a video file
  var maxSizeBytes = (videoMime.indexOf(mediaType) >= 0) ? MAX_VIDEO_SIZE_BYTES : MAX_FILE_SIZE_BYTES;

  // Check the file size - it should not go over 15MB for sync mode (not using media_category), 512MB for async-mode videos.
  // See https://dev.twitter.com/rest/reference/post/media/upload-chunked
  if (mediaFileSizeBytes < maxSizeBytes) {
    var initParameters = {
      'command': 'INIT',
      'media_type': mediaType,
      'total_bytes': mediaFileSizeBytes
    };
    var mediaCategory = null;
    // Assign media_category if MIME type is known
    // Not officially documented, see https://twittercommunity.com/t/media-category-values/64781/7
    if (imageMime.indexOf(mediaType) >= 0) mediaCategory = 'tweet_image';
    if (animatedGifMime.indexOf(mediaType) >= 0) mediaCategory = 'tweet_gif';
    if (videoMime.indexOf(mediaType) >= 0) mediaCategory = 'tweet_video';
    if (mediaCategory) initParameters['media_category'] = mediaCategory;
    self._twit.post('media/upload', initParameters, cb);
  } else {
    var errMsg = util.format('This file is too large. Max size is %dB. Got: %dB.', maxSizeBytes, mediaFileSizeBytes);
    cb(new Error(errMsg));
  }
}

module.exports = FileUploader

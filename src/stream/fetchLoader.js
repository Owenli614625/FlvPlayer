import { mergeBuffer, throttle, calculationRate } from '../utils';
import { checkReadableStream } from '../utils/isSupported';

export default class FetchLoader {
    constructor(flv) {
        this.flv = flv;
        const { options, debug } = flv;
        this.byteLength = 0;
        this.reader = null;
        this.chunkStart = 0;
        this.contentLength = 0;
        this.data = new Uint8Array();
        this.readChunk = throttle(this.readChunk, 1000);

        this.streamRate = calculationRate(rate => {
            flv.emit('streamRate', rate);
        });

        flv.on('destroy', () => {
            this.reader.cancel();
            this.data = null;
        });

        flv.on('timeupdate', currentTime => {
            if (!flv.options.live && flv.player.loaded - currentTime <= 5) {
                this.readChunk();
            }
        });

        if (checkReadableStream() && !flv.isMobile) {
            this.initFetchStream();
        } else {
            fetch(options.url, {
                method: 'head',
            }).then(response => {
                this.contentLength = Number(response.headers.get('content-length')) || options.filesize;
                debug.error(
                    this.contentLength,
                    `Unable to get response header 'content-length' or custom options 'filesize'`,
                );
                this.initFetchRange(0, flv.options.chunkSize);
            });
        }
    }

    readChunk() {
        const { options } = this.flv;
        const chunkEnd = Math.min(this.chunkStart + options.chunkSize, this.data.length);
        if (chunkEnd > this.chunkStart) {
            const chunkData = this.data.subarray(this.chunkStart, chunkEnd);
            this.flv.emit('streaming', chunkData);
            this.chunkStart = chunkEnd;
        }
    }

    initFetchStream() {
        const { options, debug } = this.flv;
        const self = this;
        this.flv.emit('streamStart');
        return fetch(options.url, {
            headers: options.headers,
        })
            .then(response => {
                self.reader = response.body.getReader();
                return (function read() {
                    return self.reader
                        .read()
                        .then(({ done, value }) => {
                            if (done) {
                                self.flv.emit('streamEnd');
                                debug.log('stream-end', `${self.byteLength} byte`);
                                return;
                            }

                            const uint8 = new Uint8Array(value);
                            self.byteLength += uint8.byteLength;
                            self.streamRate(uint8.byteLength);

                            if (options.live) {
                                self.flv.emit('streaming', uint8);
                            } else {
                                self.data = mergeBuffer(self.data, uint8);
                                if (self.chunkStart === 0) {
                                    self.readChunk();
                                }
                            }

                            // eslint-disable-next-line consistent-return
                            return read();
                        })
                        .catch(error => {
                            self.flv.emit('streamError', error);
                            throw error;
                        });
                })();
            })
            .catch(error => {
                self.flv.emit('streamError', error);
                throw error;
            });
    }

    initFetchRange(rangeStart, rangeEnd) {
        const { options, debug } = this.flv;
        const self = this;
        this.flv.emit('streamStart');
        return fetch(options.url, {
            headers: {
                ...options.headers,
                range: `bytes=${rangeStart}-${rangeEnd}`,
            },
        })
            .then(response => response.arrayBuffer())
            .then(value => {
                debug.error(
                    value.byteLength === rangeEnd - rangeStart + 1,
                    `Unable to get correct segmentation data: ${JSON.stringify({
                        contentLength: self.contentLength,
                        byteLength: value.byteLength,
                        rangeStart,
                        rangeEnd,
                    })}`,
                );

                const uint8 = new Uint8Array(value);
                self.byteLength += uint8.byteLength;
                self.streamRate(uint8.byteLength);

                if (options.live) {
                    self.flv.emit('streaming', uint8);
                } else {
                    self.data = mergeBuffer(self.data, uint8);
                    if (self.chunkStart === 0) {
                        self.readChunk();
                    }
                }

                const nextRangeStart = Math.min(self.contentLength, rangeEnd + 1);
                const nextRangeEnd = Math.min(self.contentLength, nextRangeStart + options.chunkSize);
                if (nextRangeEnd > nextRangeStart) {
                    self.initFetchRange(nextRangeStart, nextRangeEnd);
                }
            })
            .catch(error => {
                self.flv.emit('streamError', error);
                throw error;
            });
    }
}

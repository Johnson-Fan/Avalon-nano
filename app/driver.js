var Avalon = function(device, workQueue, voltSet, freqSet) {
	var deviceType;
	var header;
	switch (device.productId) {
	case Avalon.NANO_ID:
		deviceType = "Avalon nano";
		header = "NANO" + device.deviceId;
		break;
	case Avalon.MINI_ID:
		deviceType = "Avalon4 mini";
		header = "MINI" + device.deviceId;
		break;
	}

	var connectionId;

	var version = null;
	var asicCount = 1;
	var dna = null;
	var stat = {};

	var phase = null;
	var pass = false;
	var enable = false;

	// TODO: Get Stored Setting
	// default voltage & frequncy
	voltSet = voltSet || 6500;
	freqSet = freqSet || [100, 100, 100];
	var SET_VOLT_PKG = Avalon.pkgEncode(
		Avalon.P_SET_VOLT, 0, 1, 1,
		Avalon.voltEncode(voltSet)
	);
	var SET_FREQ_PKG0 = Avalon.pkgEncode(
		Avalon.P_SET_FREQ, 0, 1, 1,
		Avalon.freqEncode([100, 100, 100])
	);
	var SET_FREQ_PKG = Avalon.pkgEncode(
		Avalon.P_SET_FREQ, 0, 1, 1,
		Avalon.freqEncode(freqSet)
	);

	var onDetect = new MinerEvent();
	var onNonce = new MinerEvent();
	var onStatus = new MinerEvent();

	var send = function(pkg) {
		chrome.hid.send(connectionId, 0, pkg, function() {
			if (chrome.runtime.lastError) {
				utils.log("error", [chrome.runtime.lastError.message], header);
				return;
			}
			utils.log("debug", ["Sent:     0x%s", utils.ab2hex(pkg)],
				header, "color: cadetblue");
		});
	};

	var receive = function() {
		chrome.hid.receive(connectionId, function(reportId, pkg) {
			if (chrome.runtime.lastError) {
				utils.log("error", [chrome.runtime.lastError.message], header);
				return;
			}
			utils.log("debug", ["Received: 0x%s", utils.ab2hex(pkg)],
				header, "color: mediumpurple");
			decode(pkg);
		});
	};

	var detect = function() {
		send(Avalon.DETECT_PKG);
		receive();
	};

	var decode = function(pkg) {
		var view = new DataView(pkg);

		var head1 = view.getUint8(0);
		var head2 = view.getUint8(1);
		if (head1 !== Avalon.CANAAN_HEAD1 ||
			head2 !== Avalon.CANAAN_HEAD2) {
				utils.log("warn", ["Wrong Package Header."], header);
				return false;
		}
		var type = view.getUint8(2);

		var data = pkg.slice(6, 38);
		var crc = view.getUint16(38, false);
		if (crc !== utils.crc16(data)) {
			utils.log("warn", ["Wrong Package CRC."], header);
			return false;
		}

		var info;
		var dataView = new DataView(data);

		switch (type) {
		case Avalon.P_ACKDETECT:
			info = {
				deviceId: device.deviceId,
				version: utils.ab2asc(data.slice(8, 23)),
				dna: utils.ab2hex(data.slice(0, 8)),
				asicCount: dataView.getUint32(23, false),
			};
			dna = info.dna;
			asicCount = info.asicCount;
			// if version check passed
			pass = true;
			onDetect.fire(info);
			utils.log("info", ["Version:  %s", info.version], header, "color: green");
			utils.log("info", ["DNA:      0x%s", info.dna], header, "color: green");
			break;
		case Avalon.P_NONCE:
			for (var i = 0; i < 2; i++) {
				if (dataView.getUint8(i * 16 + 6) === 0xff)
					continue;
				info = {
					deviceId: device.deviceId,
					nonce: dataView.getUint32(i * 16 + 8) - 0x4000,
					nonce2: dataView.getUint32(i * 16 + 2),
					jqId: dataView.getUint8(i * 16 + 1),
					poolId: dataView.getUint8(i * 16 + 0),
					ntime: dataView.getUint8(i * 16 + 7),
				};
				onNonce.fire(info);
				utils.log("log",
					["Nonce:    0x%s, roll %s",
						utils.padLeft((info.nonce >>> 0).toString(16)),
						info.ntime],
					header, "color: blue");
			}
			break;
		case Avalon.P_STATUS:
			info = (deviceType === "Avalon nano") ? {
					frequency: dataView.getUint32(0),
					led: utils.padLeft((dataView.getUint32(4) >>> 0).toString(16)),
					voltage25: dataView.getUint32(12),
					voltageCore: dataView.getUint32(16),
					temperature: dataView.getUint32(20),
					voltage18: dataView.getUint16(24),
					voltage09: dataView.getUint16(26),
					power: dataView.getUint32(28),
				} : {
					spiSpeed: dataView.getUint32(0),
					led: utils.padLeft((dataView.getUint32(4) >>> 0).toString(16)),
					voltage: Avalon.voltDecode(dataView.getUint32(12)),
					voltageSource: Avalon.voltSourceDecode(dataView.getUint32(16)),
					temperatureCu: Avalon.temperatureDecode(dataView.getUint32(20)),
					temperatureFan: Avalon.temperatureDecode(dataView.getUint32(24)),
					power: dataView.getUint32(28),
				};
			if (phase === "poll")
				phase = (info.power === 1) ? "push" : "init";
			for (var key in info)
				if (info[key] === stat[key])
					delete(info[key]);
			if (Object.keys(info).length > 0) {
				var args =["Status:   "];
				for (key in info) {
					stat[key] = info[key];
					args[0] += key + " %s, ";
					args.push(info[key]);
				}
				utils.log("log", args, header, "color: green");
				info.deviceId = device.deviceId;
				onStatus.fire(info);
			}
			break;
		}
	};

	var pollPhase = function() {
		(function loop() {
			if (!enable)
				return;
			switch(phase) {
			case "poll":
				send(Avalon.POLL_PKG);
				receive();
				setTimeout(loop, 1);
				break;
			case "push":
				pushPhase();
				break;
			case "init":
				initPhase();
				break;
			}
		})();
	};

	var pushPhase = function() {
		(function loop() {
			if (!enable)
				return;
			var work = workQueue.shift();
			if (work !== undefined) {
				send(work[0]);
				send(Avalon.roll(work[1], asicCount - 1));
				phase = "poll";
				setTimeout(
				  pollPhase,
				  deviceType === "Avalon nano" ? 900 : Math.round(25 * 703 / freqSet[0])
				);
			} else
				setTimeout(loop, 10);
		})();
	};

	var initPhase = function() {
		if (!enable)
			return;
		send(SET_VOLT_PKG);
		setTimeout(function() {
			if (!enable)
				return;
			send(SET_FREQ_PKG0);
			send(SET_FREQ_PKG);
			phase = "push";
			pushPhase();
		}, 1000);
	};

	var setVoltage = function(volt) {
		if (deviceType === "Avalon nano")
			return;
		if (volt === voltSet)
			return;
		voltSet = volt;
		SET_VOLT_PKG = Avalon.pkgEncode(
			Avalon.P_SET_VOLT, 0, 1, 1,
			Avalon.voltEncode(volt)
		);
		if (phase !== null)
			send(SET_VOLT_PKG);
	};

	var setFrequency = function(freqs) {
		if (deviceType === "Avalon nano")
			return;
		if (freqs[0] === freqSet[0] &&
			freqs[1] === freqSet[1] &&
			freqs[2] === freqSet[2])
				return;
		freqSet = freqs;
		SET_FREQ_PKG = Avalon.pkgEncode(
			Avalon.P_SET_FREQ, 0, 1, 1,
			Avalon.freqEncode(freqs)
		);
		if (phase !== null)
			send(SET_FREQ_PKG);
	};

	var run = function() {
		if (!pass || enable)
			return false;
		enable = true;
		phase = "init";
		initPhase();
	};

	var connect = function() {
		chrome.hid.connect(device.deviceId, function(connection) {
			if (chrome.runtime.lastError) {
				utils.log("error", [chrome.runtime.lastError.message], header);
				// TODO: Alert failure.
				return;
			}
			connectionId = connection.connectionId;
			detect();
		});
	};

	var disconnect = function() {
		chrome.hid.disconnect(connectionId, function() {});
	};

	var halt = function() {
		enable = false;
		phase = null;
	};

	// getters
	Object.defineProperties(this, {
		deviceId: {get: function() {return device.deviceId;}},
		deviceType: {get: function() {return deviceType;}},
		dna: {get: function() {return dna;}},
	});

	// events
	this.onDetect = onDetect;
	this.onNonce = onNonce;
	this.onStatus = onStatus;

	// public functions
	this.setVoltage = setVoltage;
	this.setFrequency = setFrequency;
	this.run = run;
	this.halt = halt;
	this.connect = connect;
	this.disconnct = disconnect;
};

Avalon.VENDOR_ID = 10737; //0x29f1;
Avalon.NANO_ID = 13299; //0x33f3;
Avalon.MINI_ID = 16625; //0x40f1;
Avalon.FILTERS = {
	filters: [{
		vendorId: Avalon.VENDOR_ID,
		productId: Avalon.NANO_ID,
	}, {
		vendorId: Avalon.VENDOR_ID,
		productId: Avalon.MINI_ID,
	}]
};

Avalon.P_DETECT = 0x10;
Avalon.P_SET_VOLT = 0x22;
Avalon.P_SET_FREQ = 0x23;
Avalon.P_WORK = 0x24;
Avalon.P_POLL = 0x30;
Avalon.P_REQUIRE = 0x31;
Avalon.P_TEST = 0x32;
Avalon.P_ACKDETECT = 0x40;
Avalon.P_STATUS = 0x41;
Avalon.P_NONCE = 0x42;
Avalon.P_TEST_RET = 0x43;

Avalon.CANAAN_HEAD1 = 0x43;
Avalon.CANAAN_HEAD2 = 0x4e;

Avalon.FREQ_TABLE = [];
Avalon.FREQ_TABLE[150] = 0x22488447;
Avalon.FREQ_TABLE[163] = 0x326c8447;
Avalon.FREQ_TABLE[175] = 0x1a268447;
Avalon.FREQ_TABLE[188] = 0x1c270447;
Avalon.FREQ_TABLE[200] = 0x1e278447;
Avalon.FREQ_TABLE[213] = 0x20280447;
Avalon.FREQ_TABLE[225] = 0x22288447;
Avalon.FREQ_TABLE[238] = 0x24290447;
Avalon.FREQ_TABLE[250] = 0x26298447;
Avalon.FREQ_TABLE[263] = 0x282a0447;
Avalon.FREQ_TABLE[275] = 0x2a2a8447;
Avalon.FREQ_TABLE[288] = 0x2c2b0447;
Avalon.FREQ_TABLE[300] = 0x2e2b8447;
Avalon.FREQ_TABLE[313] = 0x302c0447;
Avalon.FREQ_TABLE[325] = 0x322c8447;
Avalon.FREQ_TABLE[338] = 0x342d0447;
Avalon.FREQ_TABLE[350] = 0x1a068447;
Avalon.FREQ_TABLE[363] = 0x382e0447;
Avalon.FREQ_TABLE[375] = 0x1c070447;
Avalon.FREQ_TABLE[388] = 0x3c2f0447;
Avalon.FREQ_TABLE[400] = 0x1e078447;

Avalon.pkgEncode = function(type, opt, idx, cnt, data) {
	var pkg = new ArrayBuffer(40);
	var pkgArray = new Uint8Array(pkg);
	var pkgView = new DataView(pkg);

	pkgArray[0] = Avalon.CANAAN_HEAD1;
	pkgArray[1] = Avalon.CANAAN_HEAD2;
	pkgArray[2] = type;
	pkgArray[3] = opt;
	pkgArray[4] = idx;
	pkgArray[5] = cnt;

	pkgArray.set(new Uint8Array(data), 6);

	var crc = utils.crc16(pkg.slice(6, 38));
	pkgView.setUint16(38, crc, false);

	return pkg;
};

Avalon.roll = function(halfWork, roll) {
	var view = new DataView(halfWork);
	view.setUint8(14, roll);
	view.setUint16(38, utils.crc16(halfWork.slice(6, 38)), false);
	return halfWork;
};

Avalon.voltEncode = function(volt) {
	if (volt === 0)
		return utils.hex2ab("00ff");
	var buffer = new ArrayBuffer(2);
	var view = new DataView(buffer);
	view.setUint16(0, (((0x59 - (volt - 5000) / 125) & 0xff) << 1 | 1), false);
	return buffer;
};

Avalon.voltDecode = function(raw) {
	if (raw === 0xff)
		return 0;
	return (0x59 - (raw >>> 1)) * 125 + 5000;
};

Avalon.freqEncode = function(freqs) {
	var buffer = new ArrayBuffer(12);
	var view = new DataView(buffer);
	for (var i = 0; i < 3; i++)
		view.setUint32(i * 4, Avalon.FREQ_TABLE[
			Math.round(Math.floor(freqs[i] / 12.5) * 12.5)
		]);
	return buffer;
};

Avalon.voltSourceDecode = function(raw) {
	return (raw * 3.3 / 1023 * 11).toFixed(1);
};

Avalon.temperatureDecode = function(raw) {
	return (1 / (1 / (25 + 273.15) -
		Math.log((1023 / raw) - 1) /
		3450) - 273.15).toFixed(1);
};

Avalon.DETECT_PKG = Avalon.pkgEncode(Avalon.P_DETECT, 0, 1, 1, 0);
Avalon.POLL_PKG = Avalon.pkgEncode(Avalon.P_POLL, 0, 1, 1, 0);

var MinerEvent = function() {
	var registered = [];

	this.addListener = function(callback) {
		return registered.push(callback) - 1;
	};

	this.removeListener = function(id) {
		delete(registered[id]);
	};

	this.fire = function(msg) {
		for (var callback of registered)
			if (callback !== undefined)
				callback(msg);
	};
};

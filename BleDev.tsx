

import React, { useRef } from 'react';
import { Pressable, PanResponder, Animated, StyleSheet, Text, View, Image, FlatList, Switch, StyleProp, 
	ViewStyle } from 'react-native';
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import { Clip } from 'react-native-full-clipboard';
import  { decode as atob, encode as btoa }from 'base-64';
import { sha256 } from 'js-sha256';
// import UTF8 from 'utf-8';

const WO_MIN = 64;

const U32_MAX = 0xFFFFFFFF;
export const COPY_UUID  = "4981333e-2d59-43b2-8dc3-8fedee1472c5";
const READ_UUID  = "07178017-1879-451b-9bb5-3ff13bb85b70";
const WRITE_UUID = "07178017-1879-451b-9bb5-3ff13bb85b71";

const VER_UUID = "b05778f1-5a88-46a3-b6c8-2d154d629910";

function decode_base64(b64: string) {
    let string = atob(b64); 
    let buf = new ArrayBuffer(string.length);
    let bv = new Uint8Array(buf);
    for (let i = 0; i < string.length; i++) {
        bv[i] = string.charCodeAt(i);
    }
    return buf;
}
function buffer_to_bs(data: ArrayBuffer | Uint8Array): string {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
    } else {
        bytes = data;
    }
    if (bytes.length > 32768) {
        let split = Math.floor(bytes.length / 2);
        let left = buffer_to_bs(bytes.subarray(0, split))
        let right = buffer_to_bs(bytes.subarray(split));
        return left + right;
    }
    // let bs = bytes.reduce((data: string, b: number) => data + String.fromCharCode(b), "");
    return String.fromCharCode.apply(null, bytes as any);
}
export function encode_base64(data: ArrayBuffer | Uint8Array): string {
    let bs = buffer_to_bs(data);
    let b64 = btoa(bs);
    return b64

}
/*
export class Clip {
    data: ArrayBuffer;
    mime: string
    constructor(data: ArrayBuffer, mime: string) {
        this.data = data;
        this.mime = mime;
    }
    eq(other: Clip) {
        if (this === other) {
            return true;
        }
        if (this.mime !== other.mime) {
            return false;
        }
        if (this.data.byteLength !== other.data.byteLength) {
            return false;
        }
        let t_view = new Uint8Array(this.data);
        let o_view = new Uint8Array(other.data);
        for (let i = 0; i < t_view.length; i++) {
            if (t_view[i] !== o_view[i]) {
                return false;
            }
        }
        return true;
    }
}
*/
class InSyncer {
	hash: string;
	msg: ArrayBuffer;
    recvd: number;
    mime: string;
	subscription: Subscription | null;
	writing: boolean;
	reading: boolean;
	device: Device;
	update_to: any;
	manualReading: boolean;
	errorState: string | null;
	onUpdate: (clip: Clip) => void;
    shouldFetch: (msgLength: number, hash: string, mime: string) => boolean;
	isClosed: boolean;
	firstReadComplete: boolean;
	constructor(device: Device, 
        onUpdate: (clip: Clip) => void,
        shouldFetch: (msgLength: number, hash: string, mime: string) => boolean
    ){
		this.onUpdate = onUpdate;
        this.shouldFetch = shouldFetch;
		this.device = device;
		this.msg = new ArrayBuffer(0);
        /* By setting the first characteristic to -1, we guarentee that the client will request a 
           position update after the characteristic read unless the read is a MSG_START message (pos -1).
         */
        this.recvd = -1; // by setting recvd to negative we guarentee the first characteristic 
        this.mime = "";
		this.hash = String.fromCharCode.apply(null, sha256.array(this.msg))
		this.manualReading = false;
		this.writing = false;
		this.reading = false;
		this.errorState = null;
		this.subscription = null;
		this.isClosed = false;
		this.firstReadComplete = false;
		this.try_init();
		// this.write_to = setTimeout(() => this.writeState(), 1000);
	}
	try_init() {
		if (this.isClosed) {
			return;
		}
		console.log("Insyncer.try_init()");
		this.device.discoverAllServicesAndCharacteristics().then((device) => {
			this.device = device;
			this.device.readCharacteristicForService(COPY_UUID, READ_UUID).then((character) => {
				this.handleChar(character);
				this.subscription = this.device.monitorCharacteristicForService(COPY_UUID, READ_UUID, (err,character) => {
					this.handleIndication(err, character);
				});
			}, (error) => {
				let err_str = JSON.stringify(error);
				console.warn("Insyncer.tryInit(): Failed to read charactersitic: ", err_str);
				this.errorState = error;
				this.update_to = setTimeout(() => this.try_init(), 1000);
			});
		}, (error) => {
			console.warn("Insyncer.tryInit(): Failed to discover charactersitic: ", error);
			this.errorState = error;
			this.update_to = setTimeout(() => this.try_init(), 1000);
		});
	}
	close() {
		this.isClosed = true;
		if (this.subscription !== null) {
			this.subscription.remove();
			this.subscription = null;
		}
		clearTimeout(this.update_to);
	}
    // This method writes to the server our current state.
    // Through updatePos() it also stores creates a timeout to manual read the next method.
	async writeState(include_hash: boolean) {
		if (this.writing || this.isClosed) {
			return;
		}
		console.debug("InSyncer.writeState(): cur_pos: ", this.recvd, ", msg_length: ", this.msg.byteLength);
		this.writing = true;
		// TODO: impelment message sending
		let buf = new ArrayBuffer(4);
		let dv = new DataView(buf);
		dv.setUint32(0, this.recvd, false)
		// dv.setUint32(4, this.msg.byteLength, false);
		let bytes = String.fromCharCode.apply(null, new Uint8Array(buf) as any);
		let msg = bytes;
        if (include_hash) {
            msg += this.hash;
        }
		await this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, READ_UUID, btoa(msg)).catch((err) => 
		{
				this.errorState = err;
				console.warn("Insyncer.writeState(): Failed to write to READ_UUID: ", err)
		});
		this.updatePos()
		this.writing = false;
	}
	
	/*
	 	Setups up a timeout for reading the characteristic
	 */
	updatePos() {
		clearTimeout(this.update_to);
		if (this.msg.byteLength > this.recvd) {
			this.update_to = setTimeout(() => {
				this.manualReading = true;
				this.readChar()
			}, 1000);
		} else {
			this.update_to = setTimeout(() => {
				this.readChar();
			}, 2000);
		}
	}
	async readChar() {
		if (this.isClosed || this.reading) {
			return;
		}
		this.reading = true;
		console.debug("InSyncer.readChar(): this.manualReading: ", this.manualReading);
		try {
			let character = await this.device.readCharacteristicForService(COPY_UUID, READ_UUID);
			await this.handleChar(character);
		} catch (error) {
			// retry read in a second 
			console.log("InSyncer.readChar(): failed to readChar: ", JSON.stringify(error));
			this.errorState = error;
			// this probably is nit need because write should work: this.update_to = setTimeout(() => this.readChar(), 1000);
			this.update_to = setTimeout(() => this.readChar(), 1000);
			//this.writeState(false);
		}
		this.reading = false;
		if (this.manualReading && this.recvd < this.msg.byteLength) {
			this.readChar();
		}	
	}
	async handleChar(character: Characteristic) {
		this.errorState = null;
		let data = atob(character.value as string);
		if (data.length < 4) {
			console.log("Insyncer.handleChar(): too short of message was received");
			await this.writeState(false);
			return;
		}
		let buf = new ArrayBuffer(8);
		let dv = new DataView(buf);
		for (let i = 0; i < 4; i++) {
			let code = data.charCodeAt(i);
			if (code > 255) {
				throw "Decoded data has character over 255";
			}
			dv.setUint8(i, code);
		}
		let off = dv.getUint32(0, false);
		console.debug("InSyncer.handleChar(): off: ", off);
		if (off === U32_MAX) {
            console.log("Insyncer.handleChar(): Starting new message");
            if (data.length < 40) {
			    console.log("Insyncer.handleChar(): too short of new message init was received");
            }
			let hash_slice: string = data.slice(4, 36);
            for (let i = 36; i < 40; i++) {
                let code = data.charCodeAt(i);
                if (code > 255) {
                    throw "Decoded data has character over 255.";
                }
                dv.setUint8(i - 32, code);
            }
            let len = dv.getUint32(4, false);
			this.msg = new ArrayBuffer(len);
			this.hash = hash_slice;
            this.mime = data.slice(40);

            // we want to ignore the first message
            // By setting the recvd to end of message
            // we skip the entire transfer.
            if (!this.firstReadComplete) {
                this.firstReadComplete = true;
                this.recvd = len;
            } else if (this.shouldFetch(this.msg.byteLength, this.hash, this.mime)) {
                this.recvd = 0;
            } else {
                // we also what to skip the if shouldFetch is false
                this.recvd = len;
            }

            // if we are still manualReading try to remonitor characteristic 
            if (this.manualReading) {
                if (this.subscription !== null) {
                    this.subscription.remove()
                }
				this.subscription = this.device.monitorCharacteristicForService(COPY_UUID, READ_UUID, 
                    (err,character) => {
					this.handleIndication(err, character);
			    });
            }
            await this.writeState(true);
		} else {
			if (off <= this.recvd && off <= this.msg.byteLength) {
				let diff = this.recvd - off;
                let bv = new Uint8Array(this.msg);
                // Append data
                let recvd_off = this.recvd  - diff - 4;
                for (let i = 4 + diff; i < data.length; i++) {
                    // map the bv bytes to the incoming data bytes with recvd_off(set)
                    bv[i + recvd_off] = data.charCodeAt(i);
                }
                this.recvd = data.length + recvd_off; // same mapping as above
				if (this.msg.byteLength === this.recvd) {
					if (this.msg.byteLength !== off) {
						// only update the value once, not on periodic updates from readChar().
                        let newClip = new Clip(this.msg, this.mime);
                        let newHash = String.fromCharCode.apply(null, newClip.hash);
                        if (newHash === this.hash) {
                            this.onUpdate(newClip);
                        } else {
                            console.log("InSyncer.handleChar(): Bad hash resetting to beginning");
                            this.recvd = -1;
                        }
					}
				}
		        await this.writeState(false);
			} else {
		        await this.writeState(true);
            }
		}
	}
	handleIndication(err: BleError | null, character: Characteristic | null) {
		if (err !== null) {
			let j_err = JSON.stringify(err);
			console.log("InSyncer.handleIndication(): Failed to monitior Read characteristic of ", this.device.id, ": ", j_err);
			return;
		}
		console.debug("InSyncer.handleIndication()");
		if (character === null) { return };
		this.manualReading = false;
		clearTimeout(this.update_to);
		this.handleChar(character);
	}
}
class OutSyncer {
	hash: string;
	msg: Uint8Array;
    mime: string;
	recvd: number;
	written: number;
    wo_max: number;
	device: Device;
	subscription: Subscription | null;
	manualReading: boolean;
	update_to: any;
	errorState: string | null;
	writing: boolean;
	isClosed: boolean;
		
	constructor(device: Device, clip: Clip) {
		this.device = device;
		this.msg = new Uint8Array(0);
		this.hash = "";
        this.mime = "";
		this.recvd = U32_MAX;
		this.written = 0;
		this.manualReading = false;
		this.isClosed = false;
		this.errorState = null;
		this.subscription = null;
		this.writing = false;
        this.wo_max = WO_MIN;
        this.push(clip);
	}
	try_init() {
		if (this.isClosed) {
			return;
		}
		// this initial read is needed to determine if we are reading properly
		this.device.readCharacteristicForService(COPY_UUID, WRITE_UUID).then((character) => {
			this.handleChar(character);
			this.subscription = this.device.monitorCharacteristicForService(COPY_UUID, WRITE_UUID, (err, character) => {
				this.handleIndication(err, character);
			});
		}, (err) => {
			console.warn("OutSyncer.tryInit(): Failed to read charactersitic: ", err);
			this.errorState = err;
			this.update_to = setTimeout(() => this.try_init(), 1000);
		});
	}
	close() {
		this.isClosed = true;
		if (this.subscription !== null) {
			this.subscription.remove();
			this.subscription = null;
		}
		if (this.update_to !== null) {
			clearTimeout(this.update_to);
			this.subscription = null;
		}
	}
	push(clip: Clip) {
		this.msg = new Uint8Array(clip.data);
        this.mime = clip.mime;
		this.recvd = U32_MAX;
		this.written = 0;
		this.hash = String.fromCharCode.apply(null, clip.hash);
		this.writeNext();
		
	}
	async writeNext() {
		if (this.writing || this.isClosed) {
			return;
		}
		this.writing = true;
		console.debug("OutSyncer.writeNext(): this.recvd:", this.recvd, ", this.written: ", this.written, "/", this.msg.length);
		let buf = new ArrayBuffer(4);
		let dv = new DataView(buf);
		if (this.recvd === U32_MAX) {
			dv.setUint32(0, U32_MAX, false);
            let msg = String.fromCharCode.apply(null, new Uint8Array(buf) as any) + this.hash;
			dv.setUint32(0, this.msg.length, false);
            msg += String.fromCharCode.apply(null, new Uint8Array(buf) as any) + this.mime;
			this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, WRITE_UUID, btoa(msg)).catch((error) =>	
					console.warn("OutSyncer.writeNext(): Failed to write to device: ", error));
			this.written = 0;
			this.startUpdateTo();
			this.writing = false;
			return;	
		}
        const MAX_OUT = this.wo_max * 8;
	    let target = Math.min(this.msg.length, (this.recvd + MAX_OUT));
		while (this.written < target) {
			let end = Math.min(target, (this.written + this.wo_max - 4));
			dv.setUint32(0, this.written, false);
			let len = end - this.written;
            let msg = String.fromCharCode.apply(null, new Uint8Array(buf) as any);
            let a = msg.charCodeAt(0);
            msg += String.fromCharCode.apply(null, this.msg.subarray(this.written, end) as any);
            try {
			    await this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, WRITE_UUID, 
                    btoa(msg));
			    this.written = end;
            } catch (error) {
                console.warn("OutSyncer.writeNext(): Failed to write to device: ", error);
                break;
            }
		}
		if (this.recvd !== this.msg.length) {
			this.startUpdateTo();
		}
		this.writing = false;
	}
	async readUpdate() {
		if (this.isClosed) {
			return;
		}
		console.debug("OutSyncer.readUpdate()");
		try {
			let character = await this.device.readCharacteristicForService(COPY_UUID, WRITE_UUID);
			await this.handleChar(character);
		} catch (error) {
			// retry read in a second 
			console.log("OutSyncer.readUpdate(): failed to read: ", error);
			this.update_to = setTimeout(() => this.readUpdate(), 1000);
			this.errorState = error;
            return;
		}
	    if (this.manualReading && this.recvd < this.msg.length) {
			this.readUpdate();
        }
	}
	async handleChar(character: Characteristic) {
        let data = atob(character.value as string);
		if (data.length < 4) {
			console.warn("OutSyncer.handleChar(): received message that was too short.");	
		}
		let buf = new ArrayBuffer(4);
        let dv = new DataView(buf);
        for (let i = 0; i < 4; i++) {
            dv.setUint8(i, data.charCodeAt(i));
        }
        let off = dv.getUint32(0, false);
        let hash = null;
        if (data.length >= 36) {
            hash = data.slice(4, 36);
        }
        if (this.recvd === U32_MAX) {
            if (off <= this.msg.length && hash !== null && hash === this.hash) {
                this.recvd = off;
            }
        } else if (hash !== null && hash !== this.hash) {
            this.recvd = U32_MAX;
        } else if (off <= this.recvd) {
	        // duplicate ACK was received
		    this.written = off;
		} else {
            this.recvd = off;
        }
		await this.writeNext();
	}
	handleIndication(err: BleError | null, character: Characteristic | null) {
		console.debug("OutSyncer.handleIndication()");
		if (err !== null) {
			console.log("OutSyncer.handleIndication(): Failed to monitior write characteristic of ", this.device.id, ": ", err);
			return;
		}
		if (character === null) { return; }
		this.manualReading = false;
		clearTimeout(this.update_to);
	}
	startUpdateTo() {
		clearTimeout(this.update_to);
		this.update_to = setTimeout(() => {
			this.manualReading = true;
			this.readUpdate();
		}, 1000);

	}

}


async function deviceHasCopy(device: Device) {
	try {
		let services = await device.services();
		return services.find((serv) => (serv.uuid === COPY_UUID)) !== undefined;
	} catch (error) {
		return false;
	}
}

export class BleDev {
	id: string;
	enabled: boolean;
	manager: BleManager;
	onUpdateCb: (clip: Clip, id: string, name: string | null) => void;
    shouldFetch: (msgLength: number, hash: string, mime: string) => boolean;
	bad: number;
	name: string | null;
	chosen: boolean;
	inSyncer: InSyncer | null;
	outSyncer: OutSyncer | null;
    clip: Clip
	uiTrigger: (id: string | null) => void;
	device: Device | null;
	conn_to: any;

	constructor(id: string, name: string | null, manager: BleManager, clip: Clip,
        uiTrigger: (id: string | null) => void,  
        onUpdate: (clip: Clip, id: string, name: string | null) => void,
        shouldFetch: (msgLength: number, hash: string, mime: string) => boolean
    ){
		this.id = id;
		this.name = name;
		this.manager = manager;
		this.uiTrigger = uiTrigger;
		this.onUpdateCb = onUpdate;
        this.shouldFetch = shouldFetch;
		console.log("Constructing BleDev for: ", this.id);
		this.enabled = false;
		this.bad = 0;
		this.chosen = false;
		this.device = null;
		this.inSyncer = null;
		this.outSyncer = null;
        this.clip = clip;
		// this.state.style = styles.ble_dev;
	}
	async enable() {
		console.log("BleDev.enable()");
		this.enabled = true;
		this.uiTrigger(null);
		await this.connect();
		if (this.device === null) {
			clearTimeout(this.conn_to);
			this.conn_to = setTimeout(() => this.enable(), 5000);
		} else {
			// above if check to device is still enabled after await
			this.inSyncer = new InSyncer(this.device, 
                (clip: Clip) => this.onUpdateCb(clip, this.id, this.name), this.shouldFetch);
			this.outSyncer = new OutSyncer(this.device, this.clip);
		}
		this.uiTrigger(null);
	}
	disable() {
		this.enabled = false;
		clearTimeout(this.conn_to);
		this.close()
	}

	// BleDEV is still valid after close()
	close() {
		clearTimeout(this.conn_to)
		if (this.inSyncer !== null) {
			this.inSyncer.close();
		}
		if (this.outSyncer !== null) {
			this.outSyncer.close();
		}
		this.uiTrigger(null);
	}
	// Connect to and validates the device.
	async connect()  {
		console.log("BleDev.connect(): called for: ", this.id);
		this.device = await this.manager.devices([this.id]).then((devs) => {
			if (devs.length > 0) {
				return devs[0];
			} else {
				return null;
			}
		});
		if (this.device === null || !(await this.device.isConnected())) {
            // add { refreshGatt: "OnConnected" } for refreshing handles on connect
			this.device = await this.manager.connectToDevice(this.id).catch((err) => {
				const j_str = JSON.stringify(err);
				console.log("BleDev.connect(): Failed to connected to ", this.id, ": ", j_str);
				return null;
			});
		}
		if (this.device !== null && !(await deviceHasCopy(this.device))) {
			this.device = await this.device.discoverAllServicesAndCharacteristics().then(async (dev) => {
				if (await deviceHasCopy(dev)) {
					return dev;
				} else {
					console.log("BleDev.connect(): Device ", this.id, " doesn't have Copy GATT service.")
					return null;
				}
			}, (error) => {
				console.log("BleDev.connect(): Failed to discover services of", this.id, ": ", error);
				return null;
			});
		}
        // Check the version number
        if (this.device !== null) {
            await this.device.readDescriptorForService(COPY_UUID, READ_UUID, VER_UUID).then((desc) => {
                let value = atob(desc.value as string);
                if  (value.charCodeAt(0) !== 1 || value.charCodeAt(1) < 0) {
				    console.log("BleDev.connect(): version mismatch with ", this.id);
                    this.device = null;
                }
            }, (error) => {
				console.log("BleDev.connect(): Failed to retrieve reader version descriptor", this.id, ": ", error);
                this.device = null;
            });
        }
		if (this.device !== null && this.device.mtu < 512) {
			let dev = await this.device.requestMTU(512).catch(() => {
				console.log("BleDev.connect(): Failed to request MTU of 512 for ", this.id);
				return null;
			});
			if (dev === null && this.device.mtu < 244) {
				this.device = await this.device.requestMTU(244).catch(() => {
					console.warn("BleDev.connect(): Failed to get required MTU of 244 for ", this.id);
					return null;
				});
			}
		}
		if (this.device !== null) {
			if (this.device.name !== null) {
				this.name = this.device.name;
			}
			this.device.onDisconnected((err, dev) => {
				console.warn("BleDev.connect(): Device has disconnected: ", dev.id);
				this.device = null;
				this.close();
				if (this.enabled) {
					this.conn_to = setTimeout(() => this.enable(), 5000);
				}
				this.uiTrigger(null);
			});
		}
		this.uiTrigger(null);
	}
	switchCb() {
		console.log("buttonCb(): device: ", this.id);
		if (this.enabled) {
			this.disable()
		} else {
			this.enable()
		}
	}
	getUIElement() {
		console.debug("BleDev.getUIElement(): ", this.id);
		let errorState = undefined;
		if (this.inSyncer !== null && this.inSyncer.errorState !== null) {
			errorState = this.inSyncer.errorState;
		} else if (this.outSyncer !== null && this.outSyncer.errorState !== null) {
			errorState = this.outSyncer.errorState;
		}
		return (
			<BleDevView key={this.id} id={this.id} name={this.name} chosen={this.chosen} enabled={this.enabled}
				callback={() => this.switchCb()} connected={this.device !== null} errorState={errorState} 
				delete={() => this.uiTrigger(this.id) }
				/>
		);
	}
	name_sort(right: BleDev) {
		if (this.name === null) {
			if (right.name === null) {
				return this.id.localeCompare(right.id);
			} else {
				return 1;
			}
		} else {
			if (right.name === null) {
				return -1;
			} else {
				let cmp = this.name.localeCompare(right.name);
				if (cmp !== 0) {
					return cmp;
				}
				return this.id.localeCompare(right.id);
			}
		}
	}
	cmp(right: BleDev) {
		if (this.device === null) {
			if (right.device === null) {
				return this.name_sort(right);
			} else {
				return 1;
			}
		} else {
			if (right.device === null) {
				return -1;
			} else {
				if (this.enabled) {
					if (right.enabled) {
						return this.name_sort(right);
					} else {
						return -1;
					}
				} else {
					if (right.enabled) {
						return 1;
					} else {
						return this.name_sort(right);
					}
				}
			}
		}
	}
	push(clip: Clip) {
        this.clip = clip;
		if (this.outSyncer !== null) {
			this.outSyncer.push(clip);
		}
	}
}

const styles = StyleSheet.create({
	container: {
		justifyContent: "center",
		alignItems: "stretch"
	},

	disabled: {
		backgroundColor: "#f00",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
	},
	connected: {
		backgroundColor: "#00f",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row"
	},
	enabled_bl: {
		backgroundColor: "#2962ff",
		color: "#ffffff",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
		height: 60,
	},
	ble_dev_con: {
		backgroundColor: "#757de8",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
		height: "100%",
		width: "100%",
	},
	ble_dev_dis: {
		backgroundColor: "#727272",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
		width: "100%",
		height: "100%"
	},
	status_icon: {
		width: 40,
		height: 40
	}
});

export interface BleDevListProps {
	children: Array<BleDev>,
	style?: any,
}

interface BleDevProps {
	callback: () => void,
	delete: () => void,
	name: string | null
	chosen: boolean;
	enabled: boolean;
	id: string;
	connected: boolean;
	errorState?: string;
}
export function BleDevView(props: BleDevProps) {
	let style;
	if (props.connected) {
		style = styles.ble_dev_con;
	} else {
		style = styles.ble_dev_dis;
	}
	let errorOc;
	if (props.errorState === undefined) {
		errorOc = 0.0;
	} else {
		errorOc = 1.0;
	}
	const pan = useRef(new Animated.Value(0)).current;
	const panResponder = useRef(
		PanResponder.create({
			onStartShouldSetPanResponder: (evt, gesture) => true,
			onPanResponderGrant: (evt, gesture) => {
				pan.extractOffset();
			},
			onPanResponderMove: Animated.event([
					null,
					{ dx: pan }], {useNativeDriver: false}),
			onPanResponderRelease: (evt, gesture) => {
				pan.flattenOffset();
				pan.stopAnimation((value) => {
					let target;
					if (value > 60) {
						target = 120;
					} else {
						target = 0;
					}
					Animated.spring(pan, 
						{toValue: target, velocity: gesture.vx, useNativeDriver: false}
					).start();
				});
			}
		})
	).current;
	return (<>
			<View style={
				{height: "100%", width: "100%", justifyContent: "center", backgroundColor: "#F44336", 
					position: "absolute" }} >
				<Pressable onPress={props.delete} style={({pressed}) => {
					return {
						height: "90%", 
						aspectRatio: 1, 
						borderRadius: 60, 
						alignItems: "center",
						justifyContent: "center",
						left: "5%",
						backgroundColor: pressed ? "#00000055": "#00000000", 
						opacity: pressed ? 1.0 : 0.8
					}
				}}>
					<Image source={require("./assets/delete.png")} style={{height: "80%", aspectRatio: 1}} />
				</Pressable>
			</View>
			<Animated.View style={[style, {transform: [{translateX: pan.interpolate({
					inputRange: [0, 1],
					outputRange: [0, 1],
					extrapolateLeft: "clamp"
				})}]}]}
				{...panResponder.panHandlers}
				>
				<Image source={require("./assets/star.png")}  style={
					{height: "70%", resizeMode: "center", opacity: props.chosen ? 1.0 : 0.0 }}/>
		   		 <View>
					<Text style={{color: "#ffffff", fontSize: 15 }} >{props.name}</Text>
					<Text style={{color: "#b0bec5"}} >{props.id}</Text>
				</View>
				<Image source={require("./assets/warning.png")} style={
					{height: "70%", resizeMode: "center", opacity: errorOc}}/>
				<Switch value={props.enabled} onValueChange={props.callback}/>
			</Animated.View>
			</>)
}
export function BleDevList(props: BleDevListProps) {
	return (
		<Animated.View style={props.style} >
			<FlatList contentContainerStyle={{height: "11%"}} data={props.children} renderItem={({item}) => item.getUIElement()}/>
		</Animated.View>
	);
}


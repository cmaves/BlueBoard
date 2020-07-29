

import React from 'react';
import {  StyleSheet, Text, View, Image, Linking, Switch, StyleProp, ViewStyle } from 'react-native';
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import  base64  from 'react-native-base64';
import { sha256 } from 'js-sha256';



export const COPY_UUID  = "4981333e-2d59-43b2-8dc3-8fedee1472c5";
const READ_UUID  = "07178017-1879-451b-9bb5-3ff13bb85b70";
const WRITE_UUID = "07178017-1879-451b-9bb5-3ff13bb85b71";

class InSyncer {
	hash: string;
	msg: string;
	msgLength: number;
	subscription: Subscription | null;
	writing: boolean;
	device: Device;
	update_to: Timeout | null;
	manualReading: boolean;
	errorState: string | null;
	onUpdate: (clip: string) => void;
	constructor(device: Device, onUpdate: (clip: string) => void) {
		this.onUpdate = onUpdate;
		this.device = device;
		this.hash = "";
		this.msg = "";
		this.msgLength = 0;
		this.manualReading = false;
		this.writing = false;
		this.errorState = null;
		this.subscription = null;
		this.try_init();
		// this.write_to = setTimeout(() => this.writeState(), 1000);
	}
	try_init() {
		console.log("try_init()");
		this.device.readCharacteristicForService(COPY_UUID, READ_UUID).then((character) => {
			this.handleChar(character)
			this.subscription = this.device.monitorCharacteristicForService(COPY_UUID, READ_UUID, (err,character) => {
				this.handleIndication(err, character);
			});
			this.writeState();
		}, (error) => {
			console.warn("tryInit(): Failed to read charactersitic: ", error);
			this.errorState = error;
			this.update_to = setTimeout(() => this.try_init(), 1000);
		});
	}
	close() {
		if (this.subscription !== null) {
			this.subscription.remove();
			this.subscription = null;
		}
		if (this.update_to !== null) {
			clearTimeout(this.update_to);
			this.subscription = null;
		}
	}
	async writeState() {
		console.log("InSyncer.writeState(): cur_pos: ", this.msg.length, ", msg_length: ", this.msgLength);
		if (this.writing) {
			return;
		}
		this.writing = true;
		// TODO: impelment message sending
		let buf = new ArrayBuffer(8);
		let dv = new DataView(buf);
		dv.setUint32(0, this.msg.length, false)
		dv.setUint32(4, this.msgLength, false);
		let bytes = String.fromCharCode.apply(null, new Uint8Array(buf));
		let msg = bytes + this.hash;
		await this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, READ_UUID, base64.encode(msg)).catch((err) => console.warn("writeState(): Failed to write to READ_UUID: ", err));
		if (this.msg.length !== this.msgLength) {
			this.updatePos();
		}
		this.writing = false;
	}
	updatePos() {
		if (this.update_to !== null) {
			clearTimeout(this.update_to);
		}
		this.update_to = setTimeout(() => this.readChar(true))
		this.readChar(true)
	}
	async readChar(start: boolean) {
		if (!(start || this.manualReading)) {
			return;
		}
		this.manualReading = true;
		let character;
		try {
			let character = await this.device.readCharacteristicForService(COPY_UUID, READ_UUID)
			this.handleChar(character);
			this.readChar(false);
		} catch (error) {
			this.errorState = error;
			this.update_to = setTimeout(() => this.readChar(false), 1000);
			this.writeState();
		}

	}
	handleChar(character: Characteristic) {
		this.errorState = null;
		let data = base64.decode(character.value);
		let buf = new ArrayBuffer(8);
		let dv = new DataView(buf);
		for (let i = 0; i < 8; i++) {
			let code = data.charCodeAt(i);
			if (code > 255) {
				throw "Decoded data has character over 255";
			}
			dv.setUint8(i, code);
		}
		let off = dv.getUint32(0, false);
		let len = dv.getUint32(4, false);
		console.debug("handleChar(): off: ", off, ", len: ", len);
		if (off === 0xFFFFFFFF) {
			let hash_slice: string = data.slice(8, 40);
			if (this.msgLength !== len || this.hash !== hash_slice) {
				console.log("handleChar(): Receiving new hash");
				this.msgLength = len;
				this.hash = hash_slice;
				this.msg = "";
			}
		} else {
			if (off <= this.msg.length) {
				let diff = this.msg.length - off;
				if (len === (data.length - 8 - diff)) {
					this.msg += data.slice(8 + diff * 2);
				} else {
				}
				if (this.msgLength === this.msg.length) {
					this.onUpdate(this.msg);
				}
			}
		}
		this.writeState();
	}
	handleIndication(err: BleError | null, character: Characteristic | null) {
		console.debug("handleIndication()");
		if (err !== null) {
			console.log("handleIndication(): Failed to monitior Read characteristic of ", this.device.id, ": ", err);
			return;
		}
		if (character === null) { return };
		this.manualReading = false;
		this.handleChar(character);

	}

}
class OutSyncer {
	hash: string;
	msg: string;
	recvd: number;
	written: number;
	device: Device;
	write_to: Timeout | null;
		
	constructor(device: Device) {
		this.device = device;
		this.msg = "";
		this.hash = "";
		this.recvd = 0;
		this.push("");
	}
	try_init() {
		// this initial read is needed to determine if we are reading properly
		this.device.readCharacteristicForService(COPY_UUID, WRITE_UUID).then(() => {

		});
	}
	close() {

	}
	push(clip: string) {
		this.msg = clip;
		this.recvd = 0;
		this.written = 0;
		this.hash = String.fromCharCode.apply(null, sha256.array(this.msg));
		this.writeNext();
		
	}
	async writeNext() {
		let buf = new ArrayBuffer(8);
		let dv = new DataView(buf);
		if (this.recvd === 0xFFFFFFFF) {
			dv.setUint32(0, this.written, false);
			dv.setUint32(4, this.msg.length, false);
			let msg = String.fromCharCode.apply(null, buf) + this.hash;
			this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, READ_UUID, base64.encode(msg)).catch((error) =>	
					console.warn("OutSyncer.writeNext(): Failed to write to device: ", error));
			this.written = 0;
			this.startWriteTo();
			return;	
		}
		const MAX_OUT = this.device.mtu * 8;
		let target = Math.min(this.msg.length, (this.recvd + MAX_OUT));
		while (this.written < target) {
			let end = Math.min(target, (this.written + 512 - 8));
			dv.setUint32(0, this.written, false);
			let len = end - this.written;
			dv.setUint32(4, len, false);
			let msg = String.fromCharCode.apply(null, buf) + this.msg.slice(this.written, end);
			this.device.writeCharacteristicWithoutResponseForService(COPY_UUID, READ_UUID, base64.encode(msg)).catch((error) =>
				console.warn("OutSyncer.writeNext(): Failed to write to device: ", error));
			this.startWriteTo();
			
		}
	}
	handleIndication() {
		
	}
	handleChar(character: Characteristic) {
		let data = base64.decode(character.value);
		if (data.length == 40) {
			console.warn("OutSyncer.handleChar(): received message that was too short.");	
		}
		let buf = new ArrayBuffer(8);
		let dv = new DataView(buf);
		for (let i = 0; i < 8; i++) {
			dv.setUint8(i, data.charCodeAt(i));
		}
		let curPos = dv.getUint32(0, false);
		let msgLength = dv.getUint32(4, false);
		if (msgLength != this.msg.length || data.slice(8, 40) != this.hash) {
			this.written = 0;
			this.recvd = 0xFFFFFFFF;
			this.writeNext();
			return;
		}
		if (curPos <= this.recvd) {
			// duplicate ACK was received
			this.written = curPos;
		}
		this.recvd = curPos;
		this.writeNext();
	}
	clearWriteTo() {
		if (this.write_to !== null) {
			clearTimeout(this.write_to);
		}
	}
	startWriteTo() {
		this.clearWriteTo();
		this.write_to = setTimeout(() => {
			this.writeNext();
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
	onUpdateCb: (clip: string, id: string, name: string | null) => void;
	bad: number;
	name: string | null;
	chosen: boolean;
	inSyncer: InSyncer | null;
	outSyncer: OutSyncer | null;
	uiTrigger: () => void;
	device: Device | null;
	constructor(id: string, name: string | null, manager: BleManager, uiTrigger: () => void,  onUpdate: (clip: string, id: string, name: string | null) => void)
 	{
		this.id = id;
		this.name = name;
		this.manager = manager;
		this.uiTrigger = uiTrigger;
		this.onUpdateCb = onUpdate;
		console.log("Constructing BleDev for: ", this.id);
		this.enabled = false;
		this.bad = 0;
		this.chosen = false;
		this.device = null;
		this.inSyncer = null;
		this.outSyncer = null;
		// this.state.style = styles.ble_dev;
	}
	async enable() {
		if (this.enabled) {
			return;
		}
		this.enabled = true;
		this.uiTrigger();
		await this.connect();
		if (this.device === null) {
			this.disable();
		} else if (this.enabled) {
			// above if check to device is still enabled after await
			this.inSyncer = new InSyncer(this.device, (clip) => this.onUpdate(clip));
			this.outSyncer = new OutSyncer(this.device);
		}
		this.uiTrigger();
	}
	onUpdate(clip: string) {
		this.onUpdateCb(clip, this.id , this.name)
	}
	// Connect to and validates the device.
	async connect()  {
		console.log("BleDev.connect(): called for: ", this.id);
		if (this.device === null || !(await this.device.isConnected())) {
			this.device = await this.manager.connectToDevice(this.id).catch((error) => {
				console.log("BleDev.connect(): Failed to connected to ", this.id, ": ", error);
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
		}
	}
	disable() {
		if (!this.enabled) {
			return;
		}
		this.enabled = false;
		if (this.inSyncer !== null) {
			this.inSyncer.close();
		}
		if (this.outSyncer !== null) {
			this.outSyncer.close();
		}
		this.uiTrigger();
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
		let opacity;
		if (this.chosen) {
			opacity = 1.0
		} else {
			opacity = 0.0;
		}
		let errorState = undefined;
		if (this.inSyncer !== null && this.inSyncer.errorState !== null) {
			errorState = this.inSyncer.errorState;
		}
		return (
			<BleDevView key={this.id} id={this.id} name={this.name} chosenOpacity={opacity} enabled={this.enabled} 
				callback={() => this.switchCb()} connected={this.device !== null} errorState={errorState} />
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
		backgroundColor: "#768fff",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
		height: "10%"
	},
	ble_dev_dis: {
		backgroundColor: "#555555",
		justifyContent: "space-around",
		alignItems: "center",
		flexDirection: "row",
		height: "10%"
	},
	status_icon: {
		width: 40,
		height: 40
	}
});

export interface BleDevListProps {
	children: Array<BleDev>,
	style?: StyleProp<ViewStyle>
}

interface BleDevProps {
	callback: () => void,
	name: string | null
	chosenOpacity: number;
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
	return (<View style={style}>
				<Image source={require("./assets/star.png")}  style={{height: "70%", resizeMode: "center", 
					opacity: props.chosenOpacity}}/>
			    <View>
					<Text style={{color: "#ffffff", fontSize: 15 }} >{props.name}</Text>
					<Text style={{color: "#b0bec5"}} >{props.id}</Text>
				</View>
				<Image source={require("./assets/warning.png")} style={{height: "70%", resizeMode: "center", 
					opacity: errorOc}}/>
				<Switch value={props.enabled} onValueChange={props.callback}/>
			</View>)
}
export function BleDevList(props: BleDevListProps) {
	return (
		<View style={props.style} >
			{props.children.map((child) => child.getUIElement())}
		</View>
	);
}


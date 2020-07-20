

import React from 'react';
import { StatusBar, FlatList, Alert, Button, StyleSheet, Text, View, Image, Linking, Switch } from 'react-native';
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import  base64  from 'react-native-base64';



export const COPY_UUID  = "4981333e-2d59-43b2-8dc3-8fedee1472c5";
const READ_UUID  = "07178017-1879-451b-9bb5-3ff13bb85b70";
const WRITE_UUID = "07178017-1879-451b-9bb5-3ff13bb85b71";

interface BleDevState {
	id: string;
	name: string | null;
	enabled: boolean;
	chosenOpacity: number;
}
export interface BleDevProps {
	onUpdate: (clip: string, id: string, name: string | null) => void;
	key: string;
}
export class BleDev  extends React.Component<BleDevProps, BleDevState> {
	hash: string;
	msg: string;
	enabled: boolean;
	writing: boolean;
	subscription: Subscription | null;
	msgLength: number;
	bad: number;
	state: BleDevState;
	props: BleDevProps;
	device: Device;
	goodStatus: boolean;
	chosen: boolean;
	to: Timeout | null;
	isMount: boolean;
	constructor(props: BleDevProps, device: Device) {
		super(props);
		this.device = device
		console.log("Constructing BleDev for: ", this.device.id);
		this.msg = "";
		this.msgLength = 0;
		this.writing = false;
		this.hash = "";
		this.enabled = false;
		this.bad = 0;
		this.goodStatus = true;
		this.chosen = false;
		this.subscription = null;
		this.state = { name: this.device.name, id: this.device.id, enabled: this.enabled, chosenOpacity: 0.0 };
		this.props = props;
		this.isMount = false;
		// this.state.style = styles.ble_dev;
	}
	componentDidMount() {
		this.isMount = true;
	}
	componentWillUnmount() {
		this.isMount = false;
	}
	update() {
		if (!this.isMount) {
			return;
		}
		let opacity;
		if (this.chosen) {
			opacity = 1.0
		} else {
			opacity = 0.0;
		}
		let state = { 
			name: this.device.name,
			id: this.device.id,
			enabled: this.enabled,
			chosenOpacity: opacity
		}
		this.setState(state);
	}
	switchCb() {
		console.log("buttonCb(): device: ", this.device.id);
		if (this.enabled) {
			this.disable()
		} else {
			this.enable()
		}
		this.update();
	}
	render() {
		console.debug("BleDev.render(): ", this.device.id);
		return (
			<View key={this.props.key} style={styles.ble_dev}>
				<Image source={require("./assets/star.png")}  style={{height: "70%", resizeMode: "center", opacity: this.state.chosenOpacity}}/>
			    <View>
					<Text style={{color: "#ffffff", fontSize: 15 }} >{this.state.name}</Text>
					<Text style={{color: "#b0bec5"}} >{this.state.id}</Text>
				</View>
				<Image />
				<Switch value={this.state.enabled} onValueChange={() => this.switchCb()}/>
			</View>
		);
	}
	writeState() {
		console.log("writeState(): cur_pos: ", this.msg.length, ", msg_length: ", this.msgLength);
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
		this.device.writeCharacteristicWithResponseForService(COPY_UUID, READ_UUID, base64.encode(msg)).catch((err) => console.warn("writeState(): Failed to write to READ_UUID: ", err));
		if (this.msg.length !== this.msgLength) {
			this.to = setTimeout(() => this.writeState(), 1000);
		}
		this.writing = false;
	}
	reset_to() {
		if (this.to !== null) {
			clearTimeout(this.to);
		}
		if (this.msg.length !== this.msgLength) {
			this.to = setTimeout(() => {
					this.writeState();
			});
		} else {
			this.to = null;
		}
	}
	clear_to() {
		if (this.to !== null) {
			clearTimeout(this.to);
			this.to = null;
		}
	}
	handleChar(character: Characteristic) {
		this.goodStatus = true;
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
					this.reset_to();
				} else {
					this.bad -= 1;
					if (this.bad <= 0) {
						this.writeState();
						this.bad = 31;
					}
				}
				if (this.msgLength === this.msg.length) {
					this.props.onUpdate(this.msg, this.device.id, this.device.name);
					this.chosen = true;
					this.writeState();
				}
			} else {
				this.writeState();
			}
		}

	}
	handleIndication(err: BleError | null, character: Characteristic | null) {
		console.debug("handleIndication()");
		if (err !== null) {
			console.log("handleIndication(): Failed to monitior Read characteristic of ", this.device.id, ": ", err);
			this.disable();
			this.goodStatus = false;
			this.update();
			return;
		}
		if (character === null) { return };
		this.handleChar(character);

	}
	async enable() {
		if (this.enabled) {
			return;
		}
		console.log("enable(): enabling: ", this.device.mtu);
		this.enabled = true;
		this.update();
		this.device = await this.device.discoverAllServicesAndCharacteristics();
		try {
			let char = await this.device.readCharacteristicForService(COPY_UUID, READ_UUID);
			this.handleChar(char);
		} catch (error) {
			console.warn("enable(): Failed initial read: ", error);	
			this.disable();
			return;
		}
		this.subscription = this.device.monitorCharacteristicForService(COPY_UUID, READ_UUID, (err,character) => {
			this.handleIndication(err, character);
		});
		this.writeState();
	}
	disable() {
		this.clear_to();
		if (!this.enabled) {
			return;
		}
		this.enabled = false;
		if (this.subscription !== null) {
			this.subscription.remove();
			this.subscription = null;
		}
		this.update();
	}
	deviceId() {
		return this.device.id;
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
	ble_dev: {
		backgroundColor: "#768fff",
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

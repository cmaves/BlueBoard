// @flow
// import { StatusBar } from 'expo-status-bar';
import React, {useState} from 'react';
import { StatusBar, FlatList, Alert, Button, StyleSheet, Text, View, Image, Linking, Switch } from 'react-native';
import Clipboard from "@react-native-community/clipboard";
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import AndroidOpenSettings from 'react-native-android-open-settings'
import { ImageSourcePropType } from 'react-native';
import  base64  from 'react-native-base64';
import  AsyncStorage  from '@react-native-community/async-storage';

const COPY_UUID  = "4981333e-2d59-43b2-8dc3-8fedee1472c5";
const READ_UUID  = "07178017-1879-451b-9bb5-3ff13bb85b70";
const WRITE_UUID = "07178017-1879-451b-9bb5-3ff13bb85b71";
const PREV_DEV_STR = "prevDevs";

interface BleDevState {
	id: string;
	name: string | null;
	enabled: boolean;
	chosenOpacity: number;
}
interface BleDevProps {
	onUpdate: (clip: string, id: string, name: string | null) => void;
	key: string;
}
class BleDev  extends React.Component<BleDevProps, BleDevState> {
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
		this.state = { name: this.device.name, id: this.device.id, enabled: this.enabled, opacity: 0.0 };
		this.props = props;
		// this.state.style = styles.ble_dev;
	}
	update() {
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
		this.state = state;
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
		console.log("writeState()")
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

interface SyncerState {
	sbTitle: string;
	sbText: string;
	clipState: string;
	clipSrc: string;
	clipTimeStr: string;
	devices: Array<BleDev>;
	header_style: object;
	btn_style: object;
	sbIcon: ImageSourcePropType;

}
class Syncer extends React.Component {
	prevDevs: Array<string>;
	devices: Array<BleDev>;
	manager: BleManager;
	state: SyncerState;
	clipLocalState: string;
	clipState: string;
	clipSrc: string;
	clipTime: Date;
	constructor(props) {
		super(props);
		console.log("Constructing Syncer");
		this.devices = [];
		this.prevDevs = [];
		this.manager = new BleManager();
		// this.bleEnabled = false;
		this.clipState = "";
		this.clipLocalState = "";
		this.clipSrc = "";
		this.clipTime = new Date();
		this.state = { 
			clipState: "",
			clipTimeStr: "",
			clipSrc: "",
			sbTitle: "uninit_title",
			sbIcon: require('./assets/blue_dis.png'),
			sbText: 'unitint_button',
			btn_style: styles.enabled_bl,
			devices: [],
			header_style: styles.enabled_bl
		};
		setInterval(() => {
			this.state.clipTimeStr = this.getTimeStr();
			this.setState(this.state);
		}, 1000);
		this.fetchClip();
		setInterval(() => this.fetchClip(), 2000);
		this.manager.state().then((state) => this.getBluetoothDev(state));
	}
	getTimeStr(): string {
		let elapsed  = Math.floor(((new Date()) - this.clipTime) / 1000);
		let e_min = Math.floor(elapsed / 60)
		if (e_min > 0) {
			return e_min + " minutes ago";
		} else {
			return elapsed + " seconds ago";
		}
	}
	/*
	componentDidMount() {
	}
	componentWillUnmount() {
		if (this.fc_to !== null) {
			clearTimeout(this.fc_to);
		}
	}
	*/
	async fetchClip() {
		let text;
		try {
			text = await Clipboard.getString();
			console.log("read from clipboard: " + text);
		} catch(error) {
			console.error("Failed to read from clipboard");
			text = "Error reading clipboard: " + error;
		}
		if (text !== this.clipLocalState && text !== this.clipState) {
			this.clipState = text;
			this.clipLocalState = text;
			this.clipSrc = "Your device";
		}
	}
	async checkConnDev(device: Device) {
		console.log("checkConnDev(): " + device.id);
		const devList = this.devices;
		if (devList.find((dev: BleDev) => (dev.device.id === device.id)) !== undefined) {
			console.log("checkConnDev(): device is duplicate, returning...");
			return;
		}
		if (await device.isConnected()) {
			this.setupConnected(device, devList);
		} else {
			console.log("checkConnDev(): Attempting to connect to device: " + device.id);
			device.connect().then((dev) => this.setupConnected(dev, devList), () => {console.log("Failed to connect to: ", device.id) });
		}
	}
	async addToPrevConnection(id: string) {
		if (this.prevDevs === null) {
			console.warn("addToPrevConnection(): this.prevDevs was null");
			return;
		}
		if (this.prevDevs.find((d) => (d === id)) !== undefined) {
			console.debug("addToPrevConnection(): ", id, " was present in this.prevDevs.");
			return;
		}
		try {
			this.prevDevs.push(id);
		} catch(error) {
			console.log("Error pushing to previous device: ", error);
			this.prevDevs = this.prevDevs.slice();
			this.prevDevs.push(id);
		}
		this.prevDevs.sort()
		AsyncStorage.setItem(PREV_DEV_STR, this.prevDevs.join(","));
	}
	async setupConnected(dev: Device, devList: Array<BleDev>) {
		console.debug("setupConnected(): ", dev.id);
		let services;
		try {
			dev = await dev.discoverAllServicesAndCharacteristics();
			services = await dev.services();	
		} catch(error) {
			console.warn("Failed to discover services for " + dev.id + ": " + error);
			return;
		}
		try {
			await dev.requestMTU(244);
		} catch(error) {
			console.warn("Failed to get minimum MTU of 244 for " + dev.id);
		}
		await dev.requestMTU(512).catch(() => {});
		let service = services.find((serv) => serv.uuid === COPY_UUID);
		if (service === undefined) {
			console.warn("Device " + dev + " does not contain COPY_UUID.");
			return;
		}
		this.addToPrevConnection(dev.id);
		let props: BleDevProps = {
			key: dev.id + "_syncer",
			onUpdate: (clip: string, id: string, name: string | null) => {
				this.clipState = clip;
				if (name === null) {
					this.clipSrc = id;
				} else { 
					this.clipSrc = name;
				}
				for (let dev of this.devices) {
					if (dev.chosen) {
						dev.chosen = false;
						break;
					}
				}
				this.clipTime = new Date();
				this.update(State.PoweredOn);
			}
		}
		devList.push(new BleDev(props, dev));
		this.update(State.PoweredOn)
	}
	update(bleState: State) {
		let state: SyncerState = {} as any;
		state.clipSrc = this.clipSrc;
		state.clipTimeStr = this.getTimeStr();
		this.devices = this.devices.filter((dev: BleDev) => {
			if (!dev.goodStatus) {
				console.log("Removing device for bad state: ", dev.device.id)
			}
			return dev.goodStatus;
		});
		state.devices = this.devices;
		console.debug("update(): devices: ", state.devices);
		state.clipState = this.clipState;
		if (bleState= State.PoweredOn) {
			if (this.devices.length === 0) {
				state.sbTitle = "Searching...";
				state.sbText = "Connect";
				state.sbIcon = require('./assets/blue_search.png');
				state.header_style = styles.enabled_bl
			} else {
				let device = this.devices[0];
				state.sbTitle = "Devices:"
				if (device.enabled) {
					state.sbText = "Disable All";
				} else {
					state.sbText = "Enable All";
				}
			}
		} else {
			state.sbTitle = "Bluetooth Disable";
			state.sbText = "Enable";
			state.sbIcon = require('./assets/blue_dis.png');
			state.header_style = styles.disabled
		}
		this.setState(state);
	}
	async startDevScan() {
		console.log("startDevScan()");
		this.manager.startDeviceScan([COPY_UUID], null,  async (err, dev) => {
				if (err != null) {
					console.warn("Failed to start scanning: ", err);
					setTimeout(() => { 
						this.manager.stopDeviceScan();
						this.startDevScan(); 
					}, 10000);
					return;
				}
				if (dev == null) {
					return;
				}
				let isConnected = await dev.isConnected();
				let services: Array<Service> = [];
				console.log("Scanned: ", dev.name, dev.id, dev.serviceUUIDs);
				if (isConnected) {
					services = await dev.services();
				}
				console.log("Connected: ", isConnected, " ServiceUUIDs: ", services);
				this.checkConnDev(dev)
		});
	}
	async connectPrevious() {
		if (this.prevDevs.length === 0 ) {
			let prevDevs: string | null = await AsyncStorage.getItem(PREV_DEV_STR)
			if (prevDevs === null) {
				prevDevs = "";
			}
			this.prevDevs = prevDevs.split(',');
			if (this.prevDevs[0] === "") {
				this.prevDevs = [];
			}
		}
		console.debug("connectPrevious(): ", this.prevDevs);
		for (let id of this.prevDevs) {
			console.debug("connectPrevious(): id: ", id);
			this.manager.connectToDevice(id).then((dev) => this.checkConnDev(dev), (err) => console.log("connectPrevious(): Failed to connect to ", id, ": ", err));
		}
		/*
		this.manager.devices(this.prevDevs).then((devs: Array<Device>) => {
			console.debug("connectPrevious(): Ble devices:", devs);
			for (let dev of devs) {
				this.checkConnDev(dev);	
			}
		}, (err) => console.warn("Error: getting previous devices failed: ", err));
		*/
		
	}
	async getBluetoothDev(newState: State) {
		console.log("getBluetoothDev(): " + newState);
		if (newState === State.PoweredOn) {
			this.manager.onStateChange((state) => {});
			this.devices = [];
			this.connectPrevious();
			this.startDevScan();
			this.manager.connectedDevices([COPY_UUID])
				.then((devices) => {
					let ids: Array<string> = devices.map((dev: Device) => { return dev.id; } );
					console.log("getBluetoothDev(): Checking devices: ", ids);
					devices.map((dev) => { this.checkConnDev(dev) }
				)});
		} else {
			this.manager.onStateChange((state) => this.getBluetoothDev(state));
		}	
		this.update(newState);
	}
	async sbButtonCb() {
		console.log("Doing sbButtonCb()");
		if (await this.manager.state() === State.PoweredOn) {
			if (this.devices.length === 0) {
				// Linking.sendIntent("android.settings.BLUETOOTH_SETTINGS");
				// Linking.openURL("android.settings.BLUETOOTH_SETTINGS");
				AndroidOpenSettings.bluetoothSettings();
			} else {
			}
		} else {
			this.manager.enable().then(() => this.manager.state()).then((state: State) => this.getBluetoothDev(state));
		}
	}
	powerOnBle(): void {
		if (this === undefined) {
			console.log("this undefined missing");
			return;
		}
		console.log(this);
		if (this.manager === undefined) { 
			console.log("Manager missing");
		} else {
			console.log("Enabling Bluetooth");
			this.manager.enable();
		}
	}
					//<FlatList data={this.state.devices} renderItem={(data) => data.item}/>
	render() {
		console.debug("Syncer.render()");
		return (
			<View style={{ justifyContent: "center", flexDirection: "column", height: "100%"}}>
				<StatusBar backgroundColor={colors.secondaryDarkColor}/>
				<View style={{ backgroundColor: colors.secondaryDarkColor, flex: 1}}>
					<Text style={{ color: colors.primaryTextColor, fontSize: 30 }}> {this.state.clipSrc}</Text>
					<Text style={{ color: "#b0bec5", paddingLeft: 25}}>Synced {this.state.clipTimeStr}</Text>
				</View>
				<View style={{ backgroundColor: "#E1E2E1", flex: 2 }}>
					<Text style={{ paddingLeft: 20 }}>{this.state.clipState}</Text>
				</View>
				<View style={{ flex: 8 }}>
					<View style={{ flex: 1, flexDirection: "row", justifyContent: "space-around", backgroundColor: colors.primaryColor, alignItems: "center"}}>
						<Image source={this.state.sbIcon} style={styles.status_icon}/>
						<Text style={{ color: colors.primaryTextColor, fontSize: 20 }}>{this.state.sbTitle}</Text>
						<Button title={this.state.sbText} onPress={() => {this.sbButtonCb()}}/>
					</View>
					<View style={{flex: 7}} >
						{this.state.devices.map((dev: BleDev) => dev.render())}
					</View>
				</View>
			</View>
  		);
	}
}
/*
			
				*/


export default Syncer;
/*
type colors_key =  "primaryColor" | "primaryLightColor" | "primaryDarkColor" | "primaryTextColor" 
	| "secondaryTextColor" | "secondaryColor" | "secondaryTextColor" | "secondaryDarkColor" | "secondaryLightColor";

type MaterialColors = { readonly [K in  colors_key] : string};
*/

const colors = {
	primaryColor: "#3f51b5",
	primaryLightColor: "#757de8",
	primaryDarkColor: "#002984",
	secondaryColor: "#25a59a",
	secondaryLightColor: "#63d7cb",
	secondaryDarkColor: "#00756c",
	primaryTextColor: "#ffffff",
	secondaryTextColor: "#000000",
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
const images = [
	require('./assets/blue_search.png'),
];
enum Disconnected {
	Off = 0,
	Search = 1,
};

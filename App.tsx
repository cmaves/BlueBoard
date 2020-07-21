// @flow
// import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { StatusBar, FlatList, Alert, Button, StyleSheet, Text, View, Image, Linking, Switch } from 'react-native';
import Clipboard from "@react-native-community/clipboard";
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import AndroidOpenSettings from 'react-native-android-open-settings'
import { ImageSourcePropType } from 'react-native';
import  AsyncStorage  from '@react-native-community/async-storage';
import { BleDev, BleDevProps, COPY_UUID } from './BleDev';

const PREV_DEV_STR = "prevDevs";


interface SyncerState {
	sbTitle: string;
	sbText: string;
	clipState: string;
	clipSrc: string;
	clipTimeStr: string;
	devices: Array<BleDev>;
	header_style: object;
	sbIcon: ImageSourcePropType;

}
interface SyncerProps {

};
interface PrevDevs {
	[key: string]: string | null;
}
interface CurDevs {
	[key: string]: BleDev;
}
class Syncer extends React.Component<SyncerProps, SyncerState> {
	prevDevs: PrevDevs | null;
	devices: CurDevs;
	manager: BleManager;
	clipLocalState: string;
	clipState: string;
	clipSrc: string;
	clipTime: Date;
	isMount: boolean;
	constructor(props: SyncerProps) {
		super(props);
		console.log("Constructing Syncer");
		this.devices = {};
		this.isMount = false;
		this.prevDevs = null;
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
			devices: [],
			header_style: styles.enabled_bl
		};
		setInterval(() => {
			if (!this.isMount) {
				return;
			}
			let state = Object.assign(this.state);
			state.clipTimeStr = this.getTimeStr();
			this.setState(state);
		}, 1000);
		this.fetchClip();
		setInterval(() => this.fetchClip(), 2000);
		this.manager.state().then((state) => this.getBluetoothDev(state));
	}
	componentDidMount() {
		this.isMount = true;
	}
	componentWillUnmount() {
		this.isMount = false;
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
	async writebackPrevDevs(id: string, name?: string) {
		if (this.prevDevs === null) {
			console.warn("addToPrevConnection(): this.prevDevs was null");
			return;
		}
		if (name === undefined) {
			this.prevDevs[id] = null;
		} else {
			this.prevDevs[id] = name;
		}
		let str = JSON.stringify(this.prevDevs);
		AsyncStorage.setItem(PREV_DEV_STR, str);
	}
	update(bleState: State) {
		console.debug("update(): devices: ", this.devices);
		if (!this.isMount) {
			return;
		}
		let sbTitle;
		let sbText;
		let sbIcon;
		let header_style;
		let devices = Object.values(this.devices);
		devices.sort((left: BleDev, right: BleDev) => left.cmp(right));
		if (bleState === State.PoweredOn) {
			header_style = styles.enabled_bl
			if (devices.length === 0) {
				sbTitle = "Searching...";
				sbText = "Connect";
				sbIcon = require('./assets/blue_search.png');
			} else {
				let device = devices[0];
				sbTitle = "Devices:"
				if (device.enabled) {
					sbText = "Disable All";
				} else {
					sbText = "Enable All";
				}
			}
		} else {
			sbTitle = "Bluetooth Disable";
			sbText = "Enable";
			sbIcon = require('./assets/blue_dis.png');
			header_style = styles.disabled
		}
		
		let state: SyncerState = {
			clipState: this.clipState,
			clipSrc: this.clipSrc,
			clipTimeStr: this.getTimeStr(),
			sbTitle: sbTitle,
			sbText: sbText,
			sbIcon: sbIcon,
			devices: devices,
			header_style: header_style,
		};
		this.setState(state);
	}
	async tryAddNewDev(dev: Device) {
		if (this.devices[dev.id] !== undefined) {
			console.log("tryAddNewDev(): try adding existing devices: ", dev.id)
			this.devices[dev.id].connect()
			return;
		}
		let props: BleDevProps = {
			manager: this.manager,
			key: dev.id,
			onUpdate: (clip, id, name) => {
				this.onUpdate(clip, id, name);
			}
		};
		let bleDev = new BleDev(props);
		await bleDev.connect();
		if (bleDev.device !== null && this.devices[dev.id] === undefined) {
			console.log("tryAddNewDev(): Connected to new device: ", dev.id);
			this.devices[dev.id] = bleDev;
		} else {
			console.log("tryAddNewDev(): Failed to connect to device: ", dev.id);
		}
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
				console.log("startDevScan.cb() Scanned new device : ", dev.name, dev.id, dev.serviceUUIDs);
				this.tryAddNewDev(dev);
		});
	}
	async connectPrevious() {
		if (this.prevDevs === null) {
			let prevDevs: string | null = await AsyncStorage.getItem(PREV_DEV_STR);
			if (prevDevs === null) {
				prevDevs = "{}";
			}
			this.prevDevs = JSON.parse(prevDevs);
		}
		console.debug("connectPrevious(): ", this.prevDevs);
		for (let id in this.prevDevs) {
			console.debug("connectPrevious(): id: ", id, ", name: ", this.prevDevs[id]);
			let props: BleDevProps = {
				key: id,
				manager: this.manager,
				onUpdate: (clip, id, name) => {
					this.onUpdate(clip, id, name);
				},

			};
			let dev = new BleDev(props);
			if (this.devices[id] === undefined) {
				this.devices[id] = dev;
			}
			dev.connect();
		}
	}
	onUpdate(clip: string, id: string, name?: string) {
		this.clipState = clip;
		if (name === undefined) {
			this.clipSrc = id;
		} else {
			this.clipSrc = name;
		}
		this.clipTime = new Date();
	}
	async getBluetoothDev(newState: State) {
		console.log("getBluetoothDev(): " + newState);
		if (newState === State.PoweredOn) {
			this.manager.onStateChange((state) => {});
			this.devices = {};
			this.connectPrevious();
			this.startDevScan();
			this.manager.connectedDevices([COPY_UUID])
				.then((devices) => {
					let ids: Array<string> = devices.map((dev: Device) => { return dev.id; } );
					console.log("getBluetoothDev(): Checking devices: ", ids);
					for (let dev in devices) {
						this.tryAddNewDev(dev);
					}
				});
		} else {
			this.manager.onStateChange((state) => this.getBluetoothDev(state));
		}	
		this.update(newState);
	}
	async sbButtonCb() {
		console.log("Doing sbButtonCb()");
		if (await this.manager.state() === State.PoweredOn) {
			if (Object.keys(this.devices).length === 0) {
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

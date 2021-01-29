// @flow
// import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { Animated, Platform, StatusBar, ScrollView, Button, StyleSheet, Text, View, Image, Switch, Pressable } from 'react-native';
import Clipboard from "@react-native-community/clipboard";
import { BleManager, BleError, State, Device, Characteristic, Service, Subscription } from 'react-native-ble-plx';
import AndroidOpenSettings from 'react-native-android-open-settings'
import { ImageSourcePropType } from 'react-native';
import  AsyncStorage  from '@react-native-async-storage/async-storage';
import { BleDevList, BleDev, COPY_UUID, Clip } from './BleDev';
import {check, request, PERMISSIONS, RESULTS} from 'react-native-permissions';
import { TextDecoder, TextEncoder } from "@sinonjs/text-encoding";
import { Clipboard as Clip2 } from "react-native-clipboard-listener";
const PREV_DEV_STR = "prevDevs";
const UNSYNCED_STR = "Clipboard has not been updated yet...";
const UTF8_MIME = 'text/plain;charset=utf-8';

interface SyncerState {
	sbTitle: string;
	sbText: string;
	clipState: Clip;
	clipSrc: string;
	clipTimeStr: string;
	devices: Array<BleDev>;
	header_style: object;
	sbIcon: ImageSourcePropType;
	rotation: Animated.Value;
	clip_flex: Animated.Value;
	list_flex: Animated.Value;
	dev_sec_flex: Animated.Value;

}
interface SyncerProps {

};
interface PrevDev {
	enabled: boolean;
	name: string | null;
};
interface PrevDevs {
	[key: string]: PrevDev;
}
interface CurDevs {
	[key: string]: BleDev;
}
interface Blocked {
	[key: string]: boolean;
}

interface ClipViewProps {
    data: ArrayBuffer;
    mime: string;
}

function ClipView(props: ClipViewProps)  {
    let decoder: TextDecoder;
    let s: string;
    switch (props.mime) {
        case 'text/plain':
        case 'text/plain;charset=utf-8':
            decoder = new TextDecoder("utf-8");
            s = decoder.decode(props.data);
            return (<Text style={{ paddingLeft: 20 }}>
                {s}
            </Text>)
        case 'text/plain;charset=utf-16le':
            decoder = new TextDecoder("utf-16le");
            s = decoder.decode(props.data);
            return (<Text style={{ paddingLeft: 20 }}>
                {s}
            </Text>)
        case 'text/plain;charset=utf-16be':
            decoder = new TextDecoder("utf-16be");
            s = decoder.decode(props.data);
            return (<Text style={{ paddingLeft: 20 }}>
                {s}
            </Text>)
        default:
            return (<Text style={{ paddingLeft: 20 }}>
                Cannont process text with mime!: {props.mime}
            </Text>)
                
            
    }
    return (<>
    </>)
}

function utf16_to_buf(s: string) {

}
class Syncer extends React.Component<SyncerProps, SyncerState> {
	prevDevs: PrevDevs | null;
	devices: CurDevs;
	manager: BleManager;
	clipLocalState: Clip;
	clipState: Clip;
	clipSrc: string;
	clipTime: Date;
	isMount: boolean;
	uiUpdate: (id: string | null) => void;
	onUpdateCb: (clip: Clip, id: string, name: string | null) => void;
	fc_to: any;
	cl_to: any;
	do_to: any;
	blocked: Blocked;
	showing_devs: boolean;

	constructor(props: SyncerProps) {
		super(props);
		console.log("Constructing Syncer");
		this.devices = {};
		this.isMount = false;
		this.showing_devs = true;
		this.prevDevs = null;
		this.manager = new BleManager();
		// this.bleEnabled = false;
        let encoder = new TextEncoder();
		this.clipState = new Clip(encoder.encode(UNSYNCED_STR), UTF8_MIME);
		this.clipLocalState = this.clipState;
		this.clipSrc = "";
		this.blocked = {};
		this.clipTime = new Date();
		this.uiUpdate = (id: string | null) => this.updateDevice(id);
		this.onUpdateCb = (clip: Clip, id: string, name: string | null) => {
			this.onUpdate(clip, id, name);
		};
		this.state = { 
			clipState: this.clipState, 
			clipTimeStr: "",
			clipSrc: "",
			sbTitle: "uninit_title",
			sbIcon: require('./assets/blue_dis.png'),
			sbText: 'unitint_button',
			devices: [],
			header_style: styles.enabled_bl,
			rotation: new Animated.Value(0),
			clip_flex: new Animated.Value(3),
			list_flex: new Animated.Value(7),
			dev_sec_flex: new Animated.Value(8),
		};
		this.fc_to = setInterval(() => this.fetchClip(), 2000);
		this.manager.state().then((state) => this.getBluetoothDev(state));
	}
	componentDidMount() {
		console.log("Syncer.componentDidMount()");
		check(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION).then(async (result) => {
			switch (result) {
				case RESULTS.DENIED:
					let res = await request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION)
					if (res !== RESULTS.GRANTED) {
						console.warn("Syncer.componentDidMount(): Location access was not granted.");
						this.manager.state().then((state) => this.getBluetoothDev(state));
					}
					break;
				case RESULTS.BLOCKED:
				case RESULTS.UNAVAILABLE:
					console.warn("Syncer.componentDidMount(): Location access was not granted.");
					break;
				case RESULTS.GRANTED:
					console.log("Syncer.componentDidMount(): Permissions are given");
					break;
					
			}
		});
		this.isMount = true;
		this.cl_to = setInterval(() => {
			if (!this.isMount) {
				return;
			}
			let state = Object.assign(this.state);
			state.clipTimeStr = this.getTimeStr();
			this.setState(state);
		}, 1000);

	}
	componentWillUnmount() {
		console.log("Syncer.componentWillUnmount()");
		this.isMount = false;
		// clearTimeout(this.fc_to);
		clearTimeout(this.cl_to);
		clearTimeout(this.do_to);
		if (this.prevDevs === null) {
			return;
		};
		// update json
		for (let id in this.devices) {
			let name = this.devices[id].name;
			let enabled = this.devices[id].enabled;
			if (this.prevDevs[id] === undefined) {
				if (enabled) { 
					this.prevDevs[id] = { name: name, enabled: enabled };
				}
			} else {
				if (name === null) {
					this.prevDevs[id].enabled = enabled;
				} else {
					this.prevDevs[id] = { name: name, enabled: enabled };
				}
			}
		}
		let str = JSON.stringify(this.prevDevs);
		AsyncStorage.setItem(PREV_DEV_STR, str);
	}
	getTimeStr(): string {
		let elapsed  = Math.floor(((new Date() as any) - (this.clipTime as any)) / 1000);
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
		let text: Clip;
        let encoder = new TextEncoder();
		try {
            let s = await Clipboard.getString();
            text = new Clip(encoder.encode(s), UTF8_MIME);
			console.debug("Syncer.fetchClip(): read from clipboard: " + text.data);
		} catch(error) {
			console.error("Failed to read from clipboard");
            let err_str = "Error reading clipboard: " + error;
            text = new Clip(encoder.encode(err_str), UTF8_MIME);
		}
        if (!text.eq(this.clipLocalState) && !text.eq(this.clipState)) {
			this.clipState = text;
			this.clipLocalState = text;
			this.clipSrc = "Your device";
			for (let id in this.devices) {
				this.devices[id].push(this.clipState);
			}
			this.update(await this.manager.state());
		}
	}
    async fetchClip2() {
        let clipManager = new Clip2(['text/plain']);
        let clip = await clipManager.getNextClip();
        console.log("fetchClip2(): clip: ", clip)
        clipManager.close();
    }
	async writebackPrevDevs(id: string, name: string | null, enabled: true) {
		if (this.prevDevs === null) {
			console.warn("addToPrevConnection(): this.prevDevs was null");
			return;
		}
		if (name === null) {
			if (this.prevDevs[id] === undefined) {
				this.prevDevs[id] = { name: null, enabled: enabled };
			}
		} else {
			this.prevDevs[id] = { name: name, enabled: enabled };
		}
		let str = JSON.stringify(this.prevDevs);
		AsyncStorage.setItem(PREV_DEV_STR, str);
	}
	updateDevice(id: string | null) {
		if (id !== null) {
			this.blocked[id] = true;
			if (this.prevDevs !== null) {
				delete this.prevDevs[id];
			}
			this.devices[id].close();
			delete this.devices[id];
		}
		this.manager.state().then((state) => this.update(state));
		/*
		let devices = Object.values(this.devices);
		devices.sort((left: BleDev, right: BleDev) => left.cmp(right));
		let state = Object.assign(this.state);
		state.devices = devices;
		let count = 0;
		for (let dev of devices) {
			if (dev.device !== null && dev.enabled) {
				count += 1;
			}
		}
		this.sbTitle = count 
		this.setState(state);
		*/
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
				let count = 0;
				for (let dev of devices) {
					if (dev.device !== null && dev.enabled) {
						count += 1;
					}
				}
				let device = devices[0];
				sbTitle = count + " Active Device";
				if (count !== 1) {
					sbTitle += "s";
				}
				if (device.enabled) {
					sbText = "Disable All";
				} else {
					sbText = "Enable All";
				}
			}
		} else {
			sbTitle = "Bluetooth Disabled";
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
			dev_sec_flex: this.state.dev_sec_flex,
			list_flex: this.state.list_flex,
			clip_flex: this.state.clip_flex,
			rotation: this.state.rotation,
		};
		this.setState(state);
	}
	async tryAddNewDev(dev: Device) {
		console.log("tryAddNewDev(): ", dev.id);
		if (this.devices[dev.id] !== undefined) {
			console.log("Syncer.tryAddNewDev(): try adding existing devices: ", dev.id)
			this.devices[dev.id].connect()
			return;
		}
		if (this.blocked[dev.id]) {
			console.log("Syncer.tryAddNewDev(): Device blocked by previous deletion: ", dev.id);
			return;
		}
		let bleDev = new BleDev(dev.id, dev.name, this.manager, this.uiUpdate, this.onUpdateCb);
		await bleDev.connect();
		// recheck this.devices for undefined because of previous await-statement
		if (bleDev.device !== null && this.devices[dev.id] === undefined) {
			console.log("tryAddNewDev(): Connected to new device: ", dev.id);
			this.devices[dev.id] = bleDev;
			this.update(State.PoweredOn);
		} else {
			console.log("tryAddNewDev(): Failed to connect to device: ", dev.id);
		}
		console.debug("tryAddNewDev(): this.devices: ", this.devices);
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
				console.log("Nothing in storage.");
				this.prevDevs = {};
			} else {
				try {
					this.prevDevs = JSON.parse(prevDevs);
				} catch (error) {
					console.warn("Failed to parse json from storage: ", error);
					this.prevDevs = {};
				}
			}
		}
		console.debug("connectPrevious(): ", this.prevDevs);
		for (let id in this.prevDevs) {
			let name = this.prevDevs[id].name;
			let enabled = this.prevDevs[id].enabled;
			console.debug("connectPrevious(): id: ", id, ", name: ", name, ", enabled: ", enabled);
			// TODO: move these to the constructor
			let dev: BleDev;
			if (this.devices[id] === undefined) {
				dev = new BleDev(id, name, this.manager, this.uiUpdate, this.onUpdateCb);
				this.devices[id] = dev;
			} else {
				dev = this.devices[id];
			}
			dev.connect().then(() => {
				if (enabled) { dev.enable() }
			});
		}
		this.updateDevice(null);
	}

	onUpdate(clip: Clip, id: string, name: string | null) {
        console.log("App.onUpdate(): New clip received with mime: " + clip.mime);
		this.clipState = clip;
		if (name === null) {
			this.clipSrc = id;
		} else {
			this.clipSrc = name;
		}
		this.clipTime = new Date();
        let decoder: TextDecoder;
        let s: string | null = null;
        switch (clip.mime) {
            case 'text/plain':
            case 'text/plain;charset=utf-8':
                decoder = new TextDecoder('utf-8');
                s = decoder.decode(clip.data);
                break;
            case 'text/plain;charset=utf-16le':
                decoder = new TextDecoder('utf-16le');
                s = decoder.decode(clip.data);
                break;
            case 'text/plain;charset=utf-16be':
                decoder = new TextDecoder('utf-16be');
                s = decoder.decode(clip.data);
                break;
            default:
                console.log("App.onUpdate(): mime not supported for clipboard.");
        }
        if (typeof s === 'string') {
		    Clipboard.setString(s);
        }
		for (let idI in this.devices) {
			if (idI !== id) {
				this.devices[idI].push(this.clipState);
			}
		}
		this.update(State.PoweredOn);
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
					for (let dev of devices) {
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
	render() {
		console.debug("Syncer.render()");
		return (
			<View style={{ justifyContent: "center", flexDirection: "column", height: "100%"}}>
				<StatusBar backgroundColor={colors.secondaryDarkColor}/>
				<View style={{ backgroundColor: colors.secondaryDarkColor, flex: 1}}>
					<Text style={{ color: colors.primaryTextColor, fontSize: 30 }}> {this.state.clipSrc}</Text>
					<Text style={{ color: "#b0bec5", paddingLeft: 25}}>Synced {this.state.clipTimeStr}</Text>
				</View>
				<Animated.View style={{ backgroundColor: "#E0E0E0", flex: this.state.clip_flex }}>
                    <ScrollView><ClipView {...this.state.clipState}/></ScrollView>
					<Pressable onPress={() => this.dropdown()} style={({pressed}) => { 
						let op = pressed ? 1.0 : 0.8;
						let bc = pressed ? "#3f51b522" : "#3f51b500";
						return { backgroundColor: bc, opacity: op, position: "absolute", bottom: "1%", right: "1%", width: "15%", aspectRatio: 1, borderRadius: 60, justifyContent: "center", alignItems: "center" };
					}}>
						<Animated.Image style={
							{height: "50%", width: "50%", transform: 
								[{ rotate: this.state.rotation.interpolate(
									{inputRange: [0, 1], outputRange: ["0deg", "180deg"] }
								)}] 
							}} source={down_arrow} />
					</Pressable>
				</Animated.View>
				<Animated.View style={{ flex: this.state.dev_sec_flex }}>
					<View style={{ flex: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-around", backgroundColor: colors.primaryColor, alignItems: "center"}}>
						<Image source={this.state.sbIcon} style={styles.status_icon}/>
						<Text style={{ color: colors.primaryTextColor, fontSize: 20 }}>{this.state.sbTitle}</Text>
						<Button title={this.state.sbText} onPress={() => {this.sbButtonCb()}}/>
					</View>
					<BleDevList style={
						{height: 0, overflow: "hidden", flex: this.state.list_flex , 
							backgroundColor: "#555555" }} 
						children={this.state.devices} />
				</Animated.View>
			</View>
  		);
	}
	dropdown() {
		this.showing_devs = !this.showing_devs;
		let state = Object.assign(this.state);
		let dropdown;
		let rotation;
		if (this.showing_devs) {
			dropdown = 0;
			rotation = 0;
		} else {
			dropdown = 7;
			rotation = 1;
		}
		Animated.parallel([
			Animated.timing(this.state.rotation, 
				{ duration: 350, toValue: dropdown, useNativeDriver: true }),
			Animated.timing(this.state.clip_flex, 
				{ duration: 350, toValue: 3 + dropdown, useNativeDriver: false }),
			Animated.timing(this.state.dev_sec_flex, 
				{ duration: 350, toValue: 8 - dropdown, useNativeDriver: false }),
			Animated.timing(this.state.list_flex, 
				{ duration: 350, toValue: 7 - dropdown, useNativeDriver: false }),
		]).start();
		/*
		LayoutAnimation.create(250, LayoutAnimation.Types.linear, LayoutAnimation.PoweredOn
		LayoutAnimation.linear();*/
		/*
		this.do_to = setInterval(() => {
			let state = Object.assign(this.state);
			state.dropdown = state.dropdown + (this.showing_devs ? -0.5 : 0.5);
			state.rotation = state.rotation + (this.showing_devs ? -9 : 9);
			this.setState(state);
			if (this.state.rotation === (180 * ((!this.showing_devs) as any))) {
				clearTimeout(this.do_to);
			}
		}, 1);
		*/
	}
}
const down_arrow = require("./assets/down_arrow.png");
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
	secondaryColor: "#26a69a",
	secondaryLightColor: "#64d8cb",
	secondaryDarkColor: "#00766c",
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

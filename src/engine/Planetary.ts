import { MDLLoader } from "@/loaders/MDLLoader";
import { GFFDataType } from "@/enums/resource/GFFDataType";
import { OdysseyModel } from "@/odyssey";
import { GFFField } from "@/resource/GFFField";
import { GFFStruct } from "@/resource/GFFStruct";
import { TwoDAObject } from "@/resource/TwoDAObject";
import { GameState } from "@/GameState";


/**
 * Planetary class.
 * 
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 * 
 * @file Planetary.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class Planetary {
  static planets: Planet[];
  static selectedIndex: number;
  static selected: Planet;

  static models: Map<string, OdysseyModel> = new Map();
  static readonly MASK_BITS = 32;

  static async Init(){

    Planetary.planets = [];
    Planetary.selectedIndex = -1;
    const planetary2DA = GameState.TwoDAManager.datatables.get('planetary');
    Planetary.selected = undefined;
    let planetList = planetary2DA.rows;
    for(let i = 0; i < planetary2DA.RowCount; i++){
      const planet = new Planet(planetList[i]);
      Planetary.planets.push(planet);
      if(planet.model != '****' && planet.model){
        try{
          const mdl = await MDLLoader.loader.load(planet.model);
          if(mdl){
            Planetary.models.set(planet.model, mdl);
          }
        }catch(e){
          console.error(e);
        }
      }
    }

  }

  /**
   * Back to a fresh game's galaxy map: nothing available, selectable or selected
   */
  static Reset(){
    for(const planet of Planetary.planets ?? []){
      planet.enabled = false;
      planet.selectable = false;
    }
    Planetary.selectedIndex = -1;
    Planetary.selected = undefined;
  }

  static SetSelectedPlanet( index = 0 ){
    Planetary.selectedIndex = index;
    Planetary.selected = Planetary.planets[index];
  }

  static SetPlanetAvailable(index: number, bState: boolean){
    const planet = Planetary.planets[index];
    if(!planet){ return; }
    planet.enabled = bState;
  }

  static SetPlanetSelectable(index: number, bState: boolean){
    const planet = Planetary.planets[index];
    if(!planet){ return; }
    planet.selectable = bState;
  }

  static GetPlanetByGUITag(sTag = ''): Planet{

    for(let i = 0; i < Planetary.planets.length; i++){
      if(Planetary.planets[i].guitag?.toLowerCase() === sTag.toLowerCase()){
        return Planetary.planets[i];
      }
    }

    return;
  }
  
  static GetPlanetByIndex(index: number = 0): Planet {
    return Planetary.planets[index];
  }

  static SaveStruct(){
    let struct = new GFFStruct();

    struct.addField( new GFFField(GFFDataType.DWORD, 'GlxyMapNumPnts') ).setValue(Planetary.planets.length);

    struct.addField( new GFFField(GFFDataType.DWORD, 'GlxyMapPlntMsk') ).setValue(Planetary.BuildMask((planet) => planet.enabled));
    struct.addField( new GFFField(GFFDataType.INT, 'GlxyMapSelPnt') ).setValue(Planetary.selectedIndex);

    // Not in retail saves; without it every planet reloads unselectable and the map can't travel.
    struct.addField( new GFFField(GFFDataType.DWORD, 'GlxyMapSelMsk') ).setValue(Planetary.BuildMask((planet) => planet.selectable));

    return struct;
  }

  /** Planet masks are DWORDs: ids outside 0..31 are dropped, since `1 << 32` would alias bit 0. */
  static BuildMask(predicate: (planet: Planet) => boolean): number {
    let mask = 0;
    for(let i = 0; i < Planetary.planets.length; i++){
      const planet = Planetary.planets[i];
      if(!predicate(planet)){ continue; }
      if(!Number.isInteger(planet.id) || planet.id < 0 || planet.id >= Planetary.MASK_BITS){
        console.warn('Planetary: planet id out of save-mask range', planet.id);
        continue;
      }
      mask |= 1 << planet.id;
    }
    return mask >>> 0;
  }

  static LoadStruct(struct: GFFStruct){
    if(!struct){ return; }
    const planetCount = struct.hasField('GlxyMapNumPnts') ? struct.getFieldByLabel('GlxyMapNumPnts').getValue() : 0;
    const availableMask = struct.hasField('GlxyMapPlntMsk') ? struct.getFieldByLabel('GlxyMapPlntMsk').getValue() : 0;
    const hasSelectableMask = struct.hasField('GlxyMapSelMsk');
    // Retail saves carry no selectable mask; treating available planets as selectable keeps travel possible.
    const selectableMask = hasSelectableMask ? struct.getFieldByLabel('GlxyMapSelMsk').getValue() : availableMask;
    const selectedIndex = struct.hasField('GlxyMapSelPnt') ? struct.getFieldByLabel('GlxyMapSelPnt').getValue() : -1;

    for(let i = 0; i < Planetary.planets.length; i++){
      const inSave = i < planetCount && i < Planetary.MASK_BITS;
      Planetary.SetPlanetAvailable(i, inSave && !!((availableMask >>> i) & 0x01));
      Planetary.SetPlanetSelectable(i, inSave && !!((selectableMask >>> i) & 0x01));
    }

    Planetary.SetSelectedPlanet(selectedIndex);
  }

}

export class Planet {
  id: number;
  label: string;
  name: number;
  description: number;
  icon: string;
  model: string;
  guitag: string;
  enabled: boolean;
  selectable: boolean;
  lockedOutReason: number = -1;

  constructor(_2da: any = {}){
    this.id = parseInt(TwoDAObject.cellParser(_2da.__rowlabel));
    this.label = TwoDAObject.cellParser(_2da.label);
    this.name = parseInt( TwoDAObject.cellParser(_2da.name) );
    this.description = parseInt( TwoDAObject.cellParser(_2da.description) );
    this.icon = TwoDAObject.cellParser(_2da.icon);
    this.model = TwoDAObject.cellParser(_2da.model);
    this.guitag = TwoDAObject.cellParser(_2da.guitag);
    this.lockedOutReason = TwoDAObject.normalizeValue(_2da.lockedoutreason,'number', -1);

    this.enabled = false;
    this.selectable = false;
  }

  getId(){
    return this.id;
  }

  getLabel(){
    return this.label;
  }

  getName(): string {
    return GameState.TLKManager.TLKStrings[this.name].Value;
  }

  getDescription(): string {
    if(this.description)
      return GameState.TLKManager.TLKStrings[this.description].Value;
    else
      return '';
  }

  getIcon(){
    return this.icon;
  }

  getModel(){
    return this.model;
  }

}

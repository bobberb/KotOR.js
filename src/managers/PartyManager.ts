import { GameState } from "@/GameState";
import { GFFObject } from "@/resource/GFFObject";
import { ResourceTypes } from "@/resource/ResourceTypes";
import * as path from "path";
import * as THREE from "three";
import EngineLocation from "@/engine/EngineLocation";
import { CurrentGame } from "@/engine/CurrentGame";
import { ModuleCreature } from "@/module/ModuleCreature";
import { OdysseyModel3D } from "@/three/odyssey";
import { GFFDataType } from "@/enums/resource/GFFDataType";
import { GFFField } from "@/resource/GFFField";
import { GFFStruct } from "@/resource/GFFStruct";
import { ModuleCreatureArmorSlot } from "@/enums/module/ModuleCreatureArmorSlot";
import { ResourceLoader } from "@/loaders";
import { GameEngineType, UIIconTimerType } from "@/enums/engine";
import { PartyManagerEvent } from "@/types/PartyManagerEvent";
import { ModulePlayer } from "@/module/ModulePlayer";
import { GameFileSystem } from "@/utility/GameFileSystem";
import { JournalEntry } from "@/engine/JournalEntry";
import { DialogMessageEntry } from "@/engine/DialogMessageEntry";
import { FeedbackMessageEntry } from "@/engine/FeedbackMessageEntry";
import { PazaakCards } from "@/enums/minigames/PazaakCards";
import { PazaakSideDeckSlots } from "@/enums/minigames/PazaakSideDeckSlots";
import { type SWPortrait } from "@/engine/rules/SWPortrait";
import { ModuleObjectType } from "@/enums/module/ModuleObjectType";
import { BitWise } from "@/utility/BitWise";

export interface CurrentMember {
  isLeader: boolean,
  memberID: number
}

export interface PartyNPC {
  available: boolean;
  canSelect: boolean;
  spawned: boolean;
  template?: GFFObject;
  moduleObject?: ModuleCreature;
}

export interface PartyNPCList {
  [key: string]: PartyNPC;
}

export interface PartyPuppet {
  available: boolean;
  select: boolean;
  /** NPC_* slot that owns the puppet (AssignPUP); NPC_PLAYER is -1, undefined when unassigned */
  owner?: number;
  template?: GFFObject;
  moduleObject?: ModuleCreature;
}

/** nwscript FORMATION_* constants (SetFormation, routine 729) */
export enum PartyFormationPattern {
  WEDGE = 0,
  LINE = 1,
}

export interface PartyFormation {
  anchor: ModuleCreature;
  pattern: PartyFormationPattern;
  position: number;
}

export interface PartyPuppetList {
  [key: string]: PartyPuppet;
}

/**
 * PartyManager class.
 * 
 * KotOR JS - A remake of the Odyssey Game Engine that powered KotOR I & II
 * 
 * @file PartyManager.ts
 * @author KobaltBlu <https://github.com/KobaltBlu>
 * @license {@link https://www.gnu.org/licenses/gpl-3.0.txt|GPLv3}
 */
export class PartyManager {

  static partyTableTemplate: GFFObject;

  static party: ModuleCreature[] = [];
  static aiStyle = 0;

  /**
   * Current Player Creature (Can be overridden by with an NPC)
   * This object will be stored in the Module's PlayList on Save
   */
  static Player: ModuleCreature;
  static PlayerTemplate: GFFObject;

  /**
   * Actual Player Creature (This is the player create that was created by the player)
   * If Player is not Equal to ActualPlayer export pc.utc on Save
   */
  // static ActualPlayer: ModulePlayer;
  static ActualPlayerTemplate: GFFObject;

  static PortraitOrder: any[] = [];
  static MaxSize = 3;
  static MaxNPCCount = 2;
  static MaxPartyCount = 12;
  static NPCS: PartyNPCList = {};

  static Puppets: PartyPuppetList = {};

  static PuppetCount: number = 0;
  static MaxPuppetCount = 3;

  static Gold = 0;
  static CurrentMembers: CurrentMember[] = [];

  static InfluenceMap: Map<number, number> = new Map<number, number>();
  static ChemicalCount: number = 0;
  static ComponentCount: number = 0;

  static SwoopUpgrade1: number = -1;
  static SwoopUpgrade2: number = -1;
  static SwoopUpgrade3: number = -1;

  static readonly NPC_PLAYER = -1;
  static readonly INFLUENCE_MIN = 0;
  static readonly INFLUENCE_MAX = 100;
  static readonly INFLUENCE_DEFAULT = 50;

  /** PUP_* ids of the puppets currently in the party (PT_PUPPETS) */
  static PuppetMembers: number[] = [];

  /** NPC_* id of the companion in control, -1 for the protagonist (PT_CONTROLLED_NP) */
  static ControlledNPC: number = -1;
  static XPPool: number = 0;
  static FollowState: number = 0;
  static CheatUsed: number = 0;
  static LastGUIPanel: number = 0;

  static readonly FORMATION_SPACING = 1.5;
  static readonly FORMATION_MAX_POSITION = 10;
  static Formations: WeakMap<ModuleCreature, PartyFormation> = new WeakMap();

  static #eventListeners: Map<PartyManagerEvent, Function[]> = new Map();

  static SyncPlayerStateTemplates(){
    if(!(PartyManager.Player instanceof ModuleCreature)){
      return;
    }

    const currentPlayerTemplate = PartyManager.Player.save();
    PartyManager.PlayerTemplate = currentPlayerTemplate;

    if(PartyManager.Player instanceof ModulePlayer || PartyManager.Player.isPlayer || PartyManager.Player.npcId < 0){
      PartyManager.ActualPlayerTemplate = currentPlayerTemplate;
    }else if(!(PartyManager.ActualPlayerTemplate instanceof GFFObject)){
      PartyManager.ActualPlayerTemplate = currentPlayerTemplate;
    }
  }

  /**
   * Initialize the party manager
   * @returns void
   */
  static Initialize(){
    PartyManager.ResetPartyTableState();
  }

  /**
   * Reset everything PARTYTABLE persists, so a load never inherits the previous session's values
   */
  static ResetPartyTableState(){
    PartyManager.MaxPartyCount = GameState.GameKey == GameEngineType.TSL ? 12 : 9;
    PartyManager.MaxPuppetCount = GameState.GameKey == GameEngineType.TSL ? 3 : 0;

    for(let i = 0; i < PartyManager.MaxPartyCount; i++){
      GameState.PartyManager.InfluenceMap.set(i, PartyManager.INFLUENCE_DEFAULT);
      GameState.PartyManager.NPCS[i] = {
        available: false,
        canSelect: false,
        spawned: false
      };
    }

    for(let i = 0; i < PartyManager.MaxPuppetCount; i++){
      GameState.PartyManager.Puppets[i] = {
        available: false,
        select: true
      };
    }

    PartyManager.PuppetMembers = [];
    PartyManager.Formations = new WeakMap();
    PartyManager.ChemicalCount = 0;
    PartyManager.ComponentCount = 0;
    PartyManager.ControlledNPC = -1;
    PartyManager.XPPool = 0;
    PartyManager.FollowState = 0;
    PartyManager.CheatUsed = 0;
    PartyManager.LastGUIPanel = 0;
    PartyManager.aiStyle = 0;
    PartyManager.SwoopUpgrade1 = -1;
    PartyManager.SwoopUpgrade2 = -1;
    PartyManager.SwoopUpgrade3 = -1;
    GameState.SOLOMODE = false;
    GameState.disableHealthRegen = false;
  }

  /**
   * Load the party manager
   * @param gff - The GFF object to load
   * @returns void
   */
  static async Load(gff: GFFObject){
    if(!(gff instanceof GFFObject)){
      console.error('PartyManager.Load', gff);
      throw 'PartyManager expected gff to be of type GFFObject';
    }

    PartyManager.partyTableTemplate = gff;

    PartyManager.ResetPartyTableState();

    if(gff.RootNode.hasField('GlxyMap')){
      GameState.Planetary.LoadStruct(gff.getFieldByLabel('GlxyMap').getChildStructs()[0]);
    }

    //Init the TutorialWindowTracker      
    const tutorial2DA = GameState.TwoDAManager.datatables.get('tutorial');
    let bitCount = 0;
    if(tutorial2DA){
      bitCount = Math.ceil(tutorial2DA.RowCount / 8) * 8;
      for(let i = 0; i < bitCount; i++){
        GameState.TutorialWindowTracker[i] = 0;
      }
    }

    if(gff.RootNode.hasField('PT_TUT_WND_SHOWN')){
      let tutWindBytes = gff.RootNode.getFieldByLabel('PT_TUT_WND_SHOWN').getVoid();
      let maxBits = tutWindBytes.length * 8;
      for(let i = 0; i < maxBits; i++){
        for(let j = 0; j < 8; j++){
          let bit = (tutWindBytes[i] >> j) & 1;
          GameState.TutorialWindowTracker[ (i * 8) + j ] = bit;
        }
      }
    }
  
    if(gff.RootNode.hasField('PT_AVAIL_NPCS')){
      let avail = gff.getFieldByLabel('PT_AVAIL_NPCS').getChildStructs();
      for(let i = 0; i < avail.length; i++){
        //console.log(PartyManager.NPCS[i]);
        GameState.PartyManager.NPCS[i].available = avail[i].getFieldByLabel('PT_NPC_AVAIL').getValue();
        GameState.PartyManager.NPCS[i].canSelect = avail[i].getFieldByLabel('PT_NPC_SELECT').getValue();
      }
    }
  
    //TSL: PT_AVAIL_PUPS
    if(gff.RootNode.hasField('PT_AVAIL_PUPS')){
      let avail = gff.getFieldByLabel('PT_AVAIL_PUPS').getChildStructs();
      for(let i = 0; i < avail.length; i++){
        const puppet = GameState.PartyManager.Puppets[i];
        if(!puppet){ continue; }
        puppet.available = !!avail[i].getFieldByLabel('PT_PUP_AVAIL').getValue();
        puppet.select = !!avail[i].getFieldByLabel('PT_PUP_SELECT').getValue();
        if(avail[i].hasField('PT_PUP_OWNER')){
          const owner = avail[i].getFieldByLabel('PT_PUP_OWNER').getValue();
          puppet.owner = owner < PartyManager.NPC_PLAYER ? undefined : owner;
        }
      }
    }

    //TSL: PT_ITEM_CHEMICAL
    if(gff.RootNode.hasField('PT_ITEM_CHEMICAL')){
      GameState.PartyManager.ChemicalCount = gff.RootNode.getFieldByLabel('PT_ITEM_CHEMICAL').getValue();
    }

    //TSL: PT_ITEM_COMPONEN
    if(gff.RootNode.hasField('PT_ITEM_COMPONEN')){
      GameState.PartyManager.ComponentCount = gff.RootNode.getFieldByLabel('PT_ITEM_COMPONEN').getValue();
    }
  
    //TSL: PT_INFLUENCE
    if(gff.RootNode.hasField('PT_INFLUENCE')){
      const list = gff.getFieldByLabel('PT_INFLUENCE').getChildStructs();
      for(let i = 0; i < list.length && i < PartyManager.MaxPartyCount; i++){
        const influence = list[i].getFieldByLabel('PT_NPC_INFLUENCE').getValue();
        GameState.PartyManager.InfluenceMap.set(i, PartyManager.ClampInfluence(influence));
      }
    }

    //TSL: PT_PUPPETS
    if(gff.RootNode.hasField('PT_PUPPETS')){
      const list = gff.getFieldByLabel('PT_PUPPETS').getChildStructs();
      for(let i = 0; i < list.length; i++){
        const struct = list[i];
        // Element label is unverified against retail: accept ours, else the struct's only field.
        const field = struct.hasField('PT_PUPPET_ID') ? struct.getFieldByLabel('PT_PUPPET_ID') : struct.getFields()[0];
        const pupId = field ? field.getValue() : -1;
        if(PartyManager.Puppets[pupId] && !PartyManager.PuppetMembers.includes(pupId)){
          PartyManager.PuppetMembers.push(pupId);
        }
      }
    }

    for(let i = 0; i < PartyManager.MaxPuppetCount; i++){
      try{
        const buffer = await GameFileSystem.readFile( path.join( CurrentGame.gameinprogress_dir, 'availpup'+i+'.utc') );
        PartyManager.Puppets[i].template = buffer?.length ? new GFFObject(buffer) : undefined;
      }catch(e){
        PartyManager.Puppets[i].template = undefined;
      }
    }

    GameState.PartyManager.Gold = gff.RootNode.getFieldByLabel('PT_GOLD').getValue();

    const scalar = (label: string, fallback: number): number =>
      gff.RootNode.hasField(label) ? gff.RootNode.getFieldByLabel(label).getValue() : fallback;
    PartyManager.ControlledNPC = scalar('PT_CONTROLLED_NP', -1);
    PartyManager.XPPool = scalar('PT_XP_POOL', 0);
    PartyManager.aiStyle = scalar('PT_AISTATE', 0);
    PartyManager.FollowState = scalar('PT_FOLLOWSTATE', 0);
    PartyManager.CheatUsed = scalar('PT_CHEAT_USED', 0);
    PartyManager.LastGUIPanel = scalar('PT_LAST_GUI_PNL', 0);
    GameState.SOLOMODE = !!scalar('PT_SOLOMODE', 0);
    PartyManager.SwoopUpgrade1 = scalar('PT_SWOOP1', -1);
    PartyManager.SwoopUpgrade2 = scalar('PT_SWOOP2', -1);
    PartyManager.SwoopUpgrade3 = scalar('PT_SWOOP3', -1);
    GameState.disableHealthRegen = !!scalar('PT_DISABLEREGEN', 0);

    if(gff.RootNode.hasField('PT_CONTROLLED_NP')){
      console.log('PT_CONTROLLED_NP', gff.RootNode.getFieldByLabel('PT_CONTROLLED_NP').getValue());
    }

    if(gff.RootNode.hasField('PT_MEMBERS')){
      let pms = gff.getFieldByLabel('PT_MEMBERS').getChildStructs();
      let currentPartyInfo = [];
      GameState.PartyManager.CurrentMembers = [];
      for(let i = 0; i < pms.length; i++){
        GameState.PartyManager.CurrentMembers.push({
          isLeader: pms[i].getFieldByLabel('PT_IS_LEADER').getValue() ? true : false,
          memberID: pms[i].getFieldByLabel('PT_MEMBER_ID').getValue()
        })
      }
    }

    GameState.JournalManager.ClearEntries();
    GameState.DialogMessageManager.ClearEntries();
    GameState.FeedbackMessageManager.ClearEntries();

    if(gff.RootNode.hasField('JNL_Entries')){
      const entries = gff.RootNode.getFieldByLabel('JNL_Entries').getChildStructs();
      for(let i = 0; i < entries.length; i++){
        GameState.JournalManager.AddEntry(JournalEntry.FromStruct(entries[i]));
      }
    }

    if(gff.RootNode.hasField('JNL_SortOrder')){
      GameState.JournalManager.SortOrder = gff.RootNode.getFieldByLabel('JNL_SortOrder').getValue();
    }else{
      GameState.JournalManager.SortOrder = 0;
    }

    if(gff.RootNode.hasField('PT_DLG_MSG_LIST')){
      const entries = gff.RootNode.getFieldByLabel('PT_DLG_MSG_LIST').getChildStructs();
      for(let i = 0; i < entries.length; i++){
        GameState.DialogMessageManager.AddEntry(DialogMessageEntry.FromStruct(entries[i]));
      }
    }

    if(gff.RootNode.hasField('PT_FB_MSG_LIST')){
      const entries = gff.RootNode.getFieldByLabel('PT_FB_MSG_LIST').getChildStructs();
      for(let i = 0; i < entries.length; i++){
        GameState.FeedbackMessageManager.AddEntry(FeedbackMessageEntry.FromStruct(entries[i]));
      }
    }

    for(let i = 0; i < PartyManager.MaxPartyCount; i++){
      const id = i;
      try{
        const buffer = await GameFileSystem.readFile( path.join( CurrentGame.gameinprogress_dir, 'availnpc'+id+'.utc') );
        GameState.PartyManager.NPCS[id].template = null;
        if(buffer.length){
          GameState.PartyManager.NPCS[id].template = new GFFObject(buffer);
        }
      }catch(e){
        console.log(e);
      }
    }

    /**
     * Pazaak Cards
     * PT_PAZAAKCARDS contains the cards that the player has in their deck
     * struct child index is the card enum value
     * PT_PAZAAKCOUNT is the number of that card in the deck
     * - max index is 17
     * - unknown 18th index always contains a PT_PAZAAKCOUNT of 0 unlike the other 17 PT_PAZAAKCOUNT is a BYTE
     * - where the other 17 are INTs
     */
    if(gff.RootNode.hasField('PT_PAZAAKCARDS')){
      const list = gff.RootNode.getFieldByLabel('PT_PAZAAKCARDS').getChildStructs();
      for(let i = 0; i < list.length; i++){
        GameState.PazaakManager.Cards.set(i, {
          card: i,
          count: list[i].getFieldByLabel('PT_PAZAAKCOUNT').getValue()
        });
      }
    }

    /**
     * Pazaak Side Deck
     * PT_PAZSIDELIST contains the cards that the player has equipped in their side deck
     * struct child index is the card index in the side deck
     * PT_PAZSIDECARD is the card enum value
     * max index is 10
     */
    if(gff.RootNode.hasField('PT_PAZSIDELIST')){
      const list = gff.RootNode.getFieldByLabel('PT_PAZSIDELIST').getChildStructs();
      for(let i = 0; i < list.length; i++){
        GameState.PazaakManager.PlayerSideDeck.set(i, list[i].getFieldByLabel('PT_PAZSIDECARD').getValue());
      }
    }
    
  }

  /**
   * Export the party manager
   * @param directory - The directory to export to
   * @returns void
   */
  static async Export(directory = ''){
    return new Promise<void>( (resolve, reject) => {
      PartyManager.SyncPlayerStateTemplates();

      //Export PARTYTABLE.res
      let partytable = new GFFObject();
      partytable.FileType = 'PT  ';
      partytable.RootNode.addField(new GFFField(GFFDataType.STRUCT, 'GlxyMap')).addChildStruct( GameState.Planetary.SaveStruct() );
      const jnl_list = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'JNL_Entries'));

      for(let i = 0; i <  GameState.JournalManager.Entries.length; i++){
        jnl_list.addChildStruct(
          GameState.JournalManager.Entries[i].toStruct()
        );
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'JNL_SortOrder')).setValue(GameState.JournalManager.SortOrder ?? 0);
      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_AISTATE')).setValue(PartyManager.aiStyle | 0);
      let availNPCSList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_AVAIL_NPCS'));

      //TODO: Party Available NPCS
      let maxPartyMembers = (GameState.GameKey == GameEngineType.KOTOR) ? 9 : 12;
      for(let i = 0; i < maxPartyMembers; i++){
        let pm = GameState.PartyManager.NPCS[i];
        let availStruct = new GFFStruct();
        availStruct.addField( new GFFField(GFFDataType.BYTE, 'PT_NPC_AVAIL') ).setValue(pm.available ? 1 : 0);
        availStruct.addField( new GFFField(GFFDataType.BYTE, 'PT_NPC_SELECT') ).setValue(pm.canSelect ? 1 : 0);
        availNPCSList.addChildStruct(availStruct);
      }

      if(GameState.GameKey == GameEngineType.TSL){
        const availPuppetsList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_AVAIL_PUPS'));
        for(let i = 0; i < PartyManager.MaxPuppetCount; i++){
          const puppet = PartyManager.Puppets[i];
          const puppetStruct = new GFFStruct();
          puppetStruct.addField(new GFFField(GFFDataType.BYTE, 'PT_PUP_AVAIL')).setValue(puppet?.available ? 1 : 0);
          puppetStruct.addField(new GFFField(GFFDataType.BYTE, 'PT_PUP_SELECT')).setValue(puppet?.select ? 1 : 0);
          // -2: unassigned, since -1 is NPC_PLAYER
          puppetStruct.addField(new GFFField(GFFDataType.INT, 'PT_PUP_OWNER')).setValue(puppet?.owner ?? -2);
          availPuppetsList.addChildStruct(puppetStruct);
        }

        const puppetsList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_PUPPETS'));
        for(const pupId of PartyManager.PuppetMembers){
          const puppetStruct = new GFFStruct();
          puppetStruct.addField(new GFFField(GFFDataType.DWORD, 'PT_PUPPET_ID')).setValue(pupId);
          puppetsList.addChildStruct(puppetStruct);
        }

        partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_SWOOP1')).setValue(PartyManager.SwoopUpgrade1);
        partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_SWOOP2')).setValue(PartyManager.SwoopUpgrade2);
        partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_SWOOP3')).setValue(PartyManager.SwoopUpgrade3);
        partytable.RootNode.addField(new GFFField(GFFDataType.BYTE, 'PT_DISABLEREGEN')).setValue(GameState.disableHealthRegen ? 1 : 0);

        partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_ITEM_CHEMICAL')).setValue(GameState.PartyManager.ChemicalCount);
        partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_ITEM_COMPONEN')).setValue(GameState.PartyManager.ComponentCount);

        const influenceList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_INFLUENCE'));
        for(let i = 0; i < PartyManager.MaxPartyCount; i++){
          const influenceStruct = new GFFStruct();
          influenceStruct.addField(new GFFField(GFFDataType.INT, 'PT_NPC_INFLUENCE')).setValue(GameState.PartyManager.InfluenceMap.get(i) ?? PartyManager.INFLUENCE_DEFAULT);
          influenceList.addChildStruct(influenceStruct);
        }
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_CHEAT_USED')).setValue(PartyManager.CheatUsed | 0);
      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_CONTROLLED_NP')).setValue(PartyManager.GetControlledNPC());
      partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_COST_MULT_LIS'));

      //TODO: COST MULT LIST

      const dlg_list = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_DLG_MSG_LIST'));

      for(let i = 0; i <  GameState.DialogMessageManager.Entries.length; i++){
        dlg_list.addChildStruct(
          GameState.DialogMessageManager.Entries[i].toStruct()
        );
      }

      const fb_list = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_FB_MSG_LIST'));

      for(let i = 0; i <  GameState.FeedbackMessageManager.Entries.length; i++){
        fb_list.addChildStruct(
          GameState.FeedbackMessageManager.Entries[i].toStruct()
        );
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_FOLLOWSTATE')).setValue(PartyManager.FollowState | 0);
      partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_GOLD')).setValue(GameState.PartyManager.Gold);
      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_LAST_GUI_PNL')).setValue(PartyManager.LastGUIPanel | 0);
      let ptMembersList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_MEMBERS'));

      let numMembers = 0;
      for(let i = 0; i < GameState.PartyManager.party.length; i++){
        let member = GameState.PartyManager.party[i];
        if(member != GameState.PartyManager.Player){
          let memberStruct = new GFFStruct();
          memberStruct.addField( new GFFField(GFFDataType.BYTE, 'PT_IS_LEADER') ).setValue( GameState.getCurrentPlayer() == member ? 1 : 0 );
          memberStruct.addField( new GFFField(GFFDataType.INT, 'PT_MEMBER_ID') ).setValue( member.npcId );
          ptMembersList.addChildStruct( memberStruct );
          numMembers++;
        }
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.BYTE, 'PT_NUM_MEMBERS')).setValue(numMembers);

      /**
       * Pazaak Cards
       */
      const pazaakCardsList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_PAZAAKCARDS'));
      for(let i = 0; i < PazaakCards.MAX_CARDS + 1; i++){
        let cardStruct = new GFFStruct(0);
        const card = GameState.PazaakManager.Cards.get(i);
        const isUnusedCard = i == PazaakCards.UNUSED_CARD;
        /**
         * Pazaak Unused Card
         * - index 0-17: set the card count
         * - index 18, unknown card, not sure if it's used at all
         */
        cardStruct.addField(new GFFField( isUnusedCard ? GFFDataType.BYTE : GFFDataType.INT, 'PT_PAZAAKCOUNT'))
          .setValue(isUnusedCard ? 0 : card.count);
        pazaakCardsList.addChildStruct(cardStruct);
      }

      /**
       * Pazaak Side Deck
       */
      const pazaakSideDeckList = partytable.RootNode.addField(new GFFField(GFFDataType.LIST, 'PT_PAZSIDELIST'));
      for(let i = 0; i < PazaakSideDeckSlots.MAX_SLOTS; i++){
        let sideDeckStruct = new GFFStruct(0);
        const sideDeckCard = GameState.PazaakManager.PlayerSideDeck.get(i);
        sideDeckStruct.addField(new GFFField(GFFDataType.INT, 'PT_PAZSIDECARD'))
          .setValue(sideDeckCard);
        pazaakSideDeckList.addChildStruct(sideDeckStruct);
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.DWORD, 'PT_PLAYEDSECONDS')).setValue(GameState.time | 0);
      partytable.RootNode.addField(new GFFField(GFFDataType.BYTE, 'PT_SOLOMODE')).setValue(GameState.SOLOMODE ? 1 : 0);

      const tutorial2DA = GameState.TwoDAManager.datatables.get('tutorial');
      if(tutorial2DA){
        let byteCount = Math.ceil(tutorial2DA.RowCount / 8);
        let buffer = new Uint8Array(byteCount);
        for(let i = 0; i < byteCount; i++){
          let byte = 0;
          for(let j = 0; j < 8; j++){
            let offset = (8 * i) + j;
            let bit = GameState.TutorialWindowTracker[offset];
            if(bit){
              byte |= 1 << j;
            }
          }
          buffer[i] = byte;
        }
        partytable.RootNode.addField(new GFFField(GFFDataType.VOID, 'PT_TUT_WND_SHOWN')).setData(buffer);
      }else{
        partytable.RootNode.addField(new GFFField(GFFDataType.VOID, 'PT_TUT_WND_SHOWN')).setData(new Uint8Array(0));
      }

      partytable.RootNode.addField(new GFFField(GFFDataType.INT, 'PT_XP_POOL')).setValue(PartyManager.XPPool | 0);

      partytable.FileType = 'PT  ';
      partytable.export(path.join(directory, 'PARTYTABLE.res'), () => {
        resolve();
      }, () => {
        reject();
      });
    });
  }

  /**
   * Add gold to the party manager
   * @param amount - The amount of gold to add
   * @returns void
   */
  static AddGold(amount: number){
    if(!amount) return;
    this.Gold += amount;
    
    if(this.Gold < 0){
      this.Gold = 0;
    }

    GameState.UINotificationManager.EnableUINotificationIconType(amount > 0 ? UIIconTimerType.CREDITS_RECEIVED : UIIconTimerType.CREDITS_RECEIVED);
  }

  /**
   * Switch the leader of the party at the index
   * @param index - The index of the party member to switch the leader of
   * @returns void
   */
  static SwitchLeaderAtIndex(index: number = 0){
    index = Math.abs(index);

    if(index >= PartyManager.party.length){
      console.warn(`Index out of range: ${index}/${PartyManager.party.length}`);
      return;
    }

    if(index == 0){
      console.warn(`Party Member at index 0 is already the party leader.`);
      return PartyManager.party[0];
    }

    const pm = PartyManager.party.splice(index, 1)[0];
    PartyManager.party.unshift(pm);
    PartyManager.ProcessEventListener('change', [pm]);
    PartyManager.UpdateLeader();
    return pm;
  }

  static async AddNPCById(npcId = 0){
    if(PartyManager.IsNPCInParty(npcId)){
      return;
    }

    const arrayLength = PartyManager.CurrentMembers.push({
      isLeader: false,
      memberID: npcId
    });
    PartyManager.RebuildPortraitOrder();

    await PartyManager.LoadPartyMember(arrayLength - 1);
  }

  /**
   * Remove the NPC by the ID
   * @param npcId - The ID of the NPC to remove
   * @param leaveInWorld - Whether to leave the NPC in the world
   * @returns void
   */
  static RemoveNPCById(npcId = 0, leaveInWorld = false){
    console.log('RemoveNPCById', npcId, leaveInWorld);
    const partyMember = PartyManager.GetPartyMemberByNPCId(npcId);
    if(!partyMember){
      return;
    }

    const pmIndex = PartyManager.party.indexOf(partyMember);
    if(pmIndex == -1){
      return;
    }

    //Remove the partymember from the module
    partyMember.isPM = false;
    PartyManager.party.splice(pmIndex, 1);
    PartyManager.RebuildPortraitOrder();

    if(!leaveInWorld){
      console.log('RemoveNPCById !leaveInWorld', partyMember);
      partyMember.destroy();
    }else{
      console.log('RemoveNPCById leaveInWorld', partyMember);
      if(partyMember.container){
        partyMember.container.removeFromParent();
      }
      GameState.group.creatures.add(partyMember.container);
      GameState.module.area.attachObject(partyMember);
    }
    
    PartyManager.RemoveCurrentMemberByNPCId(npcId);
  }

  static GetPartyMemberByNPCId(npcId = 0){
    for(let i = 0; i < PartyManager.party.length; i++){
      const pm = PartyManager.party[i];
      if(pm.npcId == npcId){
        return pm;
      }
    }
    return null;
  }

  static RemovePartyMemberByNPCId(npcId = 0){
    const pm = PartyManager.GetPartyMemberByNPCId(npcId);
    if(!pm){
      return;
    }
    PartyManager.party.splice(PartyManager.party.indexOf(pm), 1);
  }

  static GetCurrentMemberByNPCId(npcId = 0){
    for(let i = 0; i < PartyManager.CurrentMembers.length; i++){
      const mem = PartyManager.CurrentMembers[i];
      if(mem.memberID == npcId){
        return mem;
      }
    }
    return null;
  }

  static RemoveCurrentMemberByNPCId(npcId = 0){
    const mem = PartyManager.GetCurrentMemberByNPCId(npcId);
    if(!mem){
      return;
    }
    const cmIndex = PartyManager.CurrentMembers.indexOf(mem);
    if(cmIndex == -1){
      return;
    }
    PartyManager.CurrentMembers.splice(cmIndex, 1);
  }

  /**
   * Get the portrait by the index
   * @param nID - The index of the portrait to get
   * @returns string
   */
  static GetPortraitByIndex(nID = 0){

    let portraitId = 0;
    let goodEvil = 50;
    if(PartyManager.NPCS[nID].template instanceof GFFObject){
      const pm = PartyManager.NPCS[nID].template;
      if(pm.RootNode.hasField('PortraitId')){
        portraitId = pm.RootNode.getFieldByLabel('PortraitId').getValue();
        goodEvil = pm.RootNode.getFieldByLabel('GoodEvil').getValue();
      }
    }

    const portrait = GameState.SWRuleSet.portraits[portraitId];
    if(!portrait){
      return;
    }

    return portrait.getPortraitGoodEvil(goodEvil);
  }

  /**
   * Rebuild the portrait order
   * @returns void
   */
  static RebuildPortraitOrder(){
    PartyManager.PortraitOrder = [];
    for(let i = 0; i < PartyManager.party.length; i++){
      const partyMember = PartyManager.party[i];
      if(!(partyMember instanceof ModuleCreature)){ continue; }

      const portraitResRef = partyMember.getPortraitResRef();
      if(!portraitResRef){ continue; }

      PartyManager.PortraitOrder.push(portraitResRef.toLowerCase());
    }

    GameState.currentLeader = PartyManager.party[0];
  }

  /**
   * Get the portrait by the resref
   * @param resref - The resref of the portrait to get
   * @returns SWPortrait
   */
  static GetPortraitByResRef( resref = '' ): SWPortrait{
    const portrait2DA = GameState.SWRuleSet.portraits;
    if(!portrait2DA || !portrait2DA.length){
      return null;
    }
    for(let i = 0, len = portrait2DA.length; i < len; i++){
      if(portrait2DA[i].baseresref.toLowerCase() != resref.toLowerCase()){
        continue;
      }
      return portrait2DA[i];    
    }
    return null;
  }

  /**
   * Add the portrait to the order
   * @param resref - The resref of the portrait to add
   * @returns void
   */
  static AddPortraitToOrder( resref = '' ){
    const normalizedResRef = resref.toLowerCase();
    if(normalizedResRef && PartyManager.PortraitOrder.indexOf(normalizedResRef) == -1 )
      PartyManager.PortraitOrder.push( normalizedResRef );
  }

  /**
   * Set the selectable state of the NPC
   * @param nID - The ID of the NPC to set the selectable state of
   * @param state - The state to set the selectable state to
   * @returns void
   */
  static SetSelectable(nID = 0, state = false){
    PartyManager.NPCS[nID].canSelect = state ? true : false;
  }

  /**
   * Check if the NPC is selectable
   * @param nID - The ID of the NPC to check if it is selectable
   * @returns boolean
   */
  static IsSelectable(nID = 0){
    return PartyManager.NPCS[nID]?.canSelect ? true : false;
  }
  
  /**
   * Check if the NPC is available
   * @param nID - The ID of the NPC to check if it is available
   * @returns boolean
   */
  static IsAvailable(nID = 0){
    return PartyManager.NPCS[nID]?.available ? true : false;
  }

  /**
   * Check if the NPC is in the party
   * @param npcId - The ID of the NPC to check if it is in the party
   * @returns boolean
   */
  static IsNPCInParty(npcId: number){
    for(let i = 0; i < PartyManager.CurrentMembers.length; i++){
      const cpm = PartyManager.CurrentMembers[i];
      if(cpm.memberID == npcId){
        return true;
      }
    }
    return false;
  }

  /**
   * Set the PartyMember to unavailable
   * @param npcId - The ID of the NPC to set to unavailable
   * @returns void
   */
  static RemoveAvailableNPC(npcId = 0){
    PartyManager.NPCS[npcId].available = false;
    PartyManager.NPCS[npcId].canSelect = false;
    PartyManager.NPCS[npcId].template;
  }


  /**
   * Add a creature template to the list of available PartyMembers
   * @param npcId - The ID of the NPC to add to the list of available PartyMembers
   * @param template - The template to add to the list of available PartyMembers
   * @returns boolean
   */
  static AddAvailableNPCByTemplate(npcId = 0, template: string|GFFObject = ''): boolean {
    if(typeof template === 'string'){
      //Load template and merge fields
      const buffer = ResourceLoader.loadCachedResource(ResourceTypes['utc'], template);
      if(buffer){
        PartyManager.NPCS[npcId].available = true;
        PartyManager.NPCS[npcId].canSelect = true;
        PartyManager.NPCS[npcId].template = new GFFObject(buffer);
        return true;
      }else{
        console.error('Failed to load character template');
      }
    }else if(template instanceof GFFObject){
      //We already have the template (From SAVEGAME)
      PartyManager.NPCS[npcId].available = true;
      PartyManager.NPCS[npcId].canSelect = true;
      PartyManager.NPCS[npcId].template = template;
      return true;
    }else{
      console.error('Failed to load character template');
    }
    return false;
  }

  static AddAvailableNPCByObject(npcId = 0, object: ModuleCreature): boolean {
    if(!BitWise.InstanceOfObject(object, ModuleObjectType.ModuleCreature)){
      return false;
    }
    PartyManager.NPCS[npcId].available = true;
    PartyManager.NPCS[npcId].canSelect = true;
    PartyManager.NPCS[npcId].template = object.save();
    return true;
  }

  static IsValidNPCSlot(npcId: number){
    return Number.isInteger(npcId) && npcId >= 0 && npcId < PartyManager.MaxPartyCount;
  }

  static ClampInfluence(value: number){
    return Math.max(PartyManager.INFLUENCE_MIN, Math.min(PartyManager.INFLUENCE_MAX, value | 0));
  }

  /**
   * TSL GetInfluence (795): 0 when nNPC is not a CNPC slot
   */
  static GetInfluence(npcId: number){
    if(!PartyManager.IsValidNPCSlot(npcId)){ return 0; }
    return PartyManager.InfluenceMap.get(npcId) ?? PartyManager.INFLUENCE_DEFAULT;
  }

  /**
   * TSL SetInfluence (796): ignored when nNPC is not a CNPC slot or the value is outside 0-100
   */
  static SetInfluence(npcId: number, influence: number){
    if(!PartyManager.IsValidNPCSlot(npcId)){ return; }
    if(!Number.isFinite(influence) || influence < PartyManager.INFLUENCE_MIN || influence > PartyManager.INFLUENCE_MAX){ return; }
    PartyManager.InfluenceMap.set(npcId, influence | 0);
  }

  /**
   * TSL ModifyInfluence (797): result clamped to 0-100
   */
  static ModifyInfluence(npcId: number, modifier: number){
    if(!PartyManager.IsValidNPCSlot(npcId)){ return; }
    PartyManager.InfluenceMap.set(npcId, PartyManager.ClampInfluence(PartyManager.GetInfluence(npcId) + (modifier | 0)));
  }

  /**
   * NPC_* id of the companion the player controls, -1 for the protagonist
   */
  static GetControlledNPC(){
    const leader = PartyManager.party[0];
    if(leader instanceof ModuleCreature){
      return (leader instanceof ModulePlayer || !(leader.npcId >= 0)) ? -1 : leader.npcId;
    }
    return PartyManager.ControlledNPC;
  }

  static IsValidPuppetSlot(pupId: number){
    return Number.isInteger(pupId) && pupId >= 0 && pupId < PartyManager.MaxPuppetCount && !!PartyManager.Puppets[pupId];
  }

  /**
   * TSL AddAvailablePUPByTemplate (836)
   */
  static AddAvailablePUPByTemplate(pupId: number, template: string|GFFObject): boolean {
    if(!PartyManager.IsValidPuppetSlot(pupId)){ return false; }
    let gff: GFFObject;
    if(template instanceof GFFObject){
      gff = template;
    }else if(typeof template === 'string' && template.length){
      const buffer = ResourceLoader.loadCachedResource(ResourceTypes['utc'], template);
      if(buffer){ gff = new GFFObject(buffer); }
    }
    if(!gff){ return false; }
    const puppet = PartyManager.Puppets[pupId];
    puppet.available = true;
    puppet.template = gff;
    return true;
  }

  /**
   * TSL AddAvailablePUPByObject (837)
   */
  static AddAvailablePUPByObject(pupId: number, object: ModuleCreature): boolean {
    if(!PartyManager.IsValidPuppetSlot(pupId)){ return false; }
    if(!BitWise.InstanceOfObject(object, ModuleObjectType.ModuleCreature)){ return false; }
    const puppet = PartyManager.Puppets[pupId];
    puppet.available = true;
    puppet.template = object.save();
    return true;
  }

  /**
   * TSL AssignPUP (838): make NPC slot nNPC (or NPC_PLAYER) the puppet's owner
   */
  static AssignPUP(pupId: number, npcId: number): boolean {
    if(!PartyManager.IsValidPuppetSlot(pupId)){ return false; }
    if(npcId != PartyManager.NPC_PLAYER && !PartyManager.IsValidNPCSlot(npcId)){ return false; }
    PartyManager.Puppets[pupId].owner = npcId;
    return true;
  }

  /**
   * TSL AddPartyPuppet (840): the puppet must already be available
   */
  static AddPartyPuppet(pupId: number, object: ModuleCreature): boolean {
    if(!PartyManager.IsValidPuppetSlot(pupId)){ return false; }
    if(!BitWise.InstanceOfObject(object, ModuleObjectType.ModuleCreature)){ return false; }
    const puppet = PartyManager.Puppets[pupId];
    if(!puppet.available){ return false; }
    for(let i = 0; i < PartyManager.MaxPuppetCount; i++){
      if(i != pupId && PartyManager.Puppets[i]?.moduleObject === object){ return false; }
    }
    puppet.moduleObject = object;
    if(!PartyManager.PuppetMembers.includes(pupId)){
      PartyManager.PuppetMembers.push(pupId);
    }
    return true;
  }

  /**
   * PUP_* id of a puppet in the party, -1 if the object is not one
   */
  static GetPuppetId(object: ModuleCreature): number {
    if(!BitWise.InstanceOfObject(object, ModuleObjectType.ModuleCreature)){ return -1; }
    for(const pupId of PartyManager.PuppetMembers){
      if(PartyManager.Puppets[pupId]?.moduleObject === object){ return pupId; }
    }
    // After a reload the creature comes back from the area save, not from PARTYTABLE; relink it by its template tag.
    const tag = object.getTag?.()?.toLowerCase();
    if(!tag){ return -1; }
    for(const pupId of PartyManager.PuppetMembers){
      const puppet = PartyManager.Puppets[pupId];
      if(!puppet || puppet.moduleObject || !puppet.template?.RootNode.hasField('Tag')){ continue; }
      if(String(puppet.template.RootNode.getFieldByLabel('Tag').getValue()).toLowerCase() == tag){
        puppet.moduleObject = object;
        return pupId;
      }
    }
    return -1;
  }

  /**
   * TSL GetPUPOwner (841): the owner's creature, if it is in the party
   */
  static GetPuppetOwner(object: ModuleCreature): ModuleCreature | undefined {
    const pupId = PartyManager.GetPuppetId(object);
    if(pupId < 0){ return undefined; }
    const owner = PartyManager.Puppets[pupId].owner;
    if(owner == undefined){ return undefined; }
    if(owner == PartyManager.NPC_PLAYER){
      return PartyManager.party.find((pm) => pm instanceof ModulePlayer || pm?.npcId == PartyManager.NPC_PLAYER) ?? PartyManager.Player;
    }
    return PartyManager.party.find((pm) => pm?.npcId == owner);
  }

  /**
   * SetFormation (729): place oCreature at nPosition (1-10) of the pattern around oAnchor
   */
  static SetFormation(anchor: ModuleCreature, creature: ModuleCreature, pattern: number, position: number): boolean {
    if(!BitWise.InstanceOfObject(anchor, ModuleObjectType.ModuleCreature)){ return false; }
    if(!BitWise.InstanceOfObject(creature, ModuleObjectType.ModuleCreature) || creature === anchor){ return false; }
    if(pattern !== PartyFormationPattern.WEDGE && pattern !== PartyFormationPattern.LINE){ return false; }
    if(!Number.isInteger(position) || position < 1 || position > PartyManager.FORMATION_MAX_POSITION){ return false; }
    PartyManager.Formations.set(creature, { anchor, pattern, position });
    return true;
  }

  /**
   * Formation slot offset in the anchor's frame: +right is the anchor's right hand, +forward is where it faces
   */
  static GetFormationOffset(pattern: PartyFormationPattern, position: number){
    const rank = Math.ceil(position / 2);
    const side = (position % 2) ? -1 : 1;
    const spacing = PartyManager.FORMATION_SPACING;
    switch(pattern){
      case PartyFormationPattern.WEDGE:
        return { right: side * spacing * rank, forward: -spacing * rank };
      case PartyFormationPattern.LINE:
      default:
        return { right: side * spacing * rank, forward: 0 };
    }
  }

  /**
   * Add a world creature to the list of Party Members and remove it from the creatures array
   * @param slot - The slot to add the creature to
   * @param creature - The creature to add to the list of Party Members
   * @returns void
   */
  static AddCreatureToParty(slot = 1, creature: ModuleCreature){
    if(!BitWise.InstanceOfObject(creature, ModuleObjectType.ModuleCreature)){
      return;
    }

    creature = creature as ModuleCreature;
    creature.isPM = true;
    creature.clearAllActions();
    PartyManager.NPCS[slot].available = true;
    //PartyManager.NPCS[nID].canSelect = true;
    PartyManager.NPCS[slot].template = creature.template;
    PartyManager.NPCS[slot].moduleObject = creature;
    //Add the creature to the party array
    PartyManager.party.push(creature);
    //Check to see if the creature needs to be removed from the creatures array
    let cIdx = GameState.module.area.creatures.indexOf(creature);
    if(cIdx > -1){
      GameState.module.area.creatures.splice(cIdx, 1);
    }
  }

  /**
   * Switch the player character
   * @param npcId - The ID of the NPC to switch the player character to
   * @returns ModuleCreature
   */
  static SwitchPlayerCharacter(npcId = 0){
    let partyMember: ModuleCreature;
    const oldPC = PartyManager.Player;

    if(oldPC instanceof ModuleCreature && (oldPC instanceof ModulePlayer || oldPC.isPlayer || oldPC.npcId < 0)){
      PartyManager.ActualPlayerTemplate = oldPC.save();
      CurrentGame.WriteFile('pc.utc', PartyManager.ActualPlayerTemplate.getExportBuffer());
    }

    if(npcId == -1){
      partyMember = new ModulePlayer(PartyManager.ActualPlayerTemplate);
      PartyManager.PlayerTemplate = PartyManager.ActualPlayerTemplate;
    }else{
      partyMember = new ModuleCreature(PartyManager.NPCS[npcId].template);
    }

    PartyManager.Player = partyMember;

    try{
      const spawn = oldPC.position.clone();
      const quaternion = oldPC.quaternion.clone();

      partyMember.isPM = true;
      partyMember.npcId = npcId;
      partyMember.load();
      // IsPC marks the real protagonist: Module load trusts a Mod_PlayerList entry with
      // IsPC=1 as ActualPlayerTemplate, so a companion in control must save 0. Set after
      // load(), which would otherwise restore whatever IsPC the template carried.
      partyMember.isPC = npcId == -1 ? 1 : 0;
      partyMember.clearAllActions();
      partyMember.position.copy(spawn);
      partyMember.quaternion.copy(quaternion);
      partyMember.loadScripts();
      partyMember.loadModel().then( (model: OdysseyModel3D) => {
        PartyManager.party[0] = partyMember;
        
        model.userData.moduleObject = partyMember;
        partyMember.position.copy(spawn);
        partyMember.quaternion.copy(quaternion);
        model.hasCollision = true;
        
        GameState.group.party.add( partyMember.container );
        oldPC.destroy();
        partyMember.onSpawn();
      });
      return partyMember;
    }catch(e){
      console.error(e);
      return undefined;
    }
  }
  static Save(){
    PartyManager.SyncPlayerStateTemplates();

    const npcs = PartyManager.party.filter( (pm) => pm instanceof ModuleCreature && pm.npcId >= 0 );
    PartyManager.CurrentMembers = npcs.map((pm) => {
      return {
        isLeader: PartyManager.party[0] == pm,
        memberID: pm.npcId
      };
    });
    for(let i = 0; i < npcs.length; i++){
      const pm = npcs[i];
      PartyManager.SavePartyMember(pm.npcId);
    }
  }

  /**
   * Shift the current leader to the end of the party array
   * @returns void
   */
  static ShiftLeader(){
    PartyManager.party.push( PartyManager.party.shift() );
    PartyManager.UpdateLeader();
  }

  /**
   * Update the party members to see if any of them is the current party leader
   * @returns void
   */
  static UpdateLeader(){
    for(let i = 0; i < PartyManager.CurrentMembers.length; i++){
      const isLeader = (PartyManager.party[0].npcId == PartyManager.CurrentMembers[i].memberID);
      PartyManager.CurrentMembers[i].isLeader = isLeader;
    }

    PartyManager.RebuildPortraitOrder();
  }

  /**
   * Check to see if the current leader is a party member and not the player
   * @returns boolean
   */
  static IsPartyMemberLeader(){
    return (PartyManager.party[0].npcId >= 0);
  }

  /**
   * Check to see if the player character is the leader of the party
   * @returns boolean
   */
  static IsPlayerPartyLeader(){
    return !PartyManager.IsPartyMemberLeader();
  }

  /**
   * Get the party member by the NPC ID
   * @param npcId - The NPC ID
   * @returns PartyMember
   */
  static GetPMByNPCId(npcId: number = -1){
    return PartyManager.party.find( (obj) => obj.npcId == npcId);
  }

  /**
   * Make the player character the leader of the party
   * @param swapWorldPositions - Whether to swap the world positions of the player and the party leader
   * @returns void
   */
  static MakePlayerLeader(swapWorldPositions: boolean = true){
    const idx = PartyManager.party.indexOf(PartyManager.Player);
    if(idx <= 0){ return; }

    const old_pm = PartyManager.party[0];
    const old_pm_pos = PartyManager.party[0].position.clone();
    const old_player_pos = PartyManager.Player.position.clone();
    PartyManager.SwitchLeaderAtIndex(idx);
    if(swapWorldPositions){
      PartyManager.Player.setPosition(old_pm_pos);
      old_pm.setPosition(old_player_pos);
    }
  }

  static GetLeaderCurrentMemberIndex(){
    return PartyManager.CurrentMembers.findIndex((member) => !!member?.isLeader);
  }

  static GetPlayerStartingPartyIndex(){
    return PartyManager.GetLeaderCurrentMemberIndex() >= 0 ? 1 : 0;
  }

  static GetCurrentMemberStartingPartyIndex(memberIndex: number){
    if(memberIndex < 0){
      return PartyManager.party.length;
    }

    const leaderIndex = PartyManager.GetLeaderCurrentMemberIndex();
    if(memberIndex == leaderIndex){
      return 0;
    }

    if(leaderIndex == -1){
      return memberIndex + 1;
    }

    return memberIndex < leaderIndex ? memberIndex + 2 : memberIndex + 1;
  }

  /**
   * Get the index of the creature in the party array using the persisted party order.
   * @param creature - The creature to get the index of
   * @returns number
   */
  static GetCreatureStartingPartyIndex(creature: ModuleCreature){
    if(!(creature instanceof ModuleCreature)){
      return PartyManager.GetPlayerStartingPartyIndex();
    }

    const existingIndex = PartyManager.party.indexOf(creature);
    if(existingIndex >= 0){
      return existingIndex;
    }

    if(creature == PartyManager.Player || creature.npcId < 0){
      return PartyManager.GetPlayerStartingPartyIndex();
    }

    const currentMemberIndex = PartyManager.CurrentMembers.findIndex((member) => member?.memberID == creature.npcId);
    if(currentMemberIndex >= 0){
      return PartyManager.GetCurrentMemberStartingPartyIndex(currentMemberIndex);
    }

    const portraitResRef = creature.getPortraitResRef();
    if(!portraitResRef){
      return PartyManager.party.length;
    }

    const normalizedPortraitResRef = portraitResRef.toLowerCase();

    if(PartyManager.PortraitOrder[0]?.toLowerCase() == normalizedPortraitResRef){
      return 0
    }else if(PartyManager.PortraitOrder[1]?.toLowerCase() == normalizedPortraitResRef){
      return 1;
    }else if(PartyManager.PortraitOrder[2]?.toLowerCase() == normalizedPortraitResRef){
      return 2
    }

    return PartyManager.party.length;

  }

  /**
   * Load the PartyMember by it's index in the CurrentMembers array.
   * @param nIdx - The index of the party member to load
   * @returns void
   */
  static async LoadPartyMember(nIdx: number = 0){
    const npc = PartyManager.NPCS[PartyManager.CurrentMembers[nIdx].memberID];
    const template = npc.template;
    template.RootNode.addField( new GFFField(GFFDataType.DWORD, 'ObjectId') ).setValue( GameState.ModuleObjectManager.GetNextPlayerId() );
    const partyMember = new ModuleCreature(template);

    if(nIdx < 0 || nIdx > 1){
      console.log('LoadPartyMember', 'Wrong index', nIdx, npc, partyMember);
      return;
    }

    let currentSlot: ModuleCreature;

    try{
      if(!(currentSlot instanceof ModuleCreature)){
        partyMember.isPM = true;
        partyMember.npcId = PartyManager.CurrentMembers[nIdx].memberID;
        partyMember.load();
        partyMember.clearAllActions();
        //PartyManager.party[nIdx+1] = partyMember;

        /*if(PartyManager.CurrentMembers[nIdx].isLeader){
          PartyManager.party.unshift(PartyManager.party.splice(nIdx+1, 1)[0]);
        }*/
        PartyManager.AddPortraitToOrder( partyMember.getPortraitResRef() );
        PartyManager.party[ PartyManager.GetCreatureStartingPartyIndex(partyMember) ] = partyMember;
        let spawn = PartyManager.GetSpawnLocation(partyMember);
        partyMember.position.copy(spawn.position);
        partyMember.setFacing(spawn.getFacing(), true);
        
        const model = await partyMember.loadModel();
        model.userData.moduleObject = partyMember;

        partyMember.position.copy(spawn.position);
        partyMember.setFacing(spawn.getFacing(), true);
        //partyMember.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1), -Math.atan2(0, 0));
  
        model.hasCollision = true;
        GameState.group.party.add( partyMember.container );

        partyMember.onSpawn();
      }else{
        const spawn = PartyManager.GetSpawnLocation(currentSlot);
        currentSlot.position.copy(spawn.position);
        currentSlot.setFacing(spawn.getFacing(), true);
        //currentSlot.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1), -Math.atan2(0, 0));
      }
    }catch(e){
      console.error(e);
    }
  }

  /**
   * Used in the TSL PartySelection menu to load creature for the 3D preview of the selected party member
   * @param npcId - The NPC ID
   * @param onLoad - The function to call when the party member is loaded
   * @returns void
   */
  static LoadPartyMemberCreature(npcId = 0, onLoad?: Function){
    const npc = PartyManager.NPCS[npcId];
    if(!npc){
      if(typeof onLoad === 'function')
        onLoad(null);

      return;
    }

    if(!npc.template){
      if(typeof onLoad === 'function')
        onLoad(null);

      return;
    }
    
    const partyMember = new ModuleCreature(npc.template);
    partyMember.npcId = npcId;
    partyMember.isPM = true;
    partyMember.load();
    partyMember.clearAllActions();
    partyMember.loadModel().then( (model: OdysseyModel3D) => {
      model.userData.moduleObject = partyMember;
      partyMember.onSpawn();
      if(typeof onLoad === 'function')
        onLoad(partyMember);

    });
    
  }

  /**
   * Get the spawn location of the creature
   * @param creature - The creature to get the spawn location of
   * @returns EngineLocation
   */
  static GetSpawnLocation( creature: ModuleCreature ){
    if( BitWise.InstanceOfObject(creature, ModuleObjectType.ModuleCreature) ){
      if( GameState.isLoadingSave ){
        return new EngineLocation(
          creature.position.x, 
          creature.position.y, 
          creature.position.z,
          creature.getXOrientation(), 
          creature.getYOrientation(), 
          creature.getZOrientation()
        );
      }else if( GameState.module.area.transWP ){
        if( GameState.module.area.transWP ){
          //console.log('TransWP - PM', GameState.module.area.transWP);
        }
        let index = PartyManager.party.indexOf(creature);
        if(index == -1){
          index = PartyManager.GetCreatureStartingPartyIndex(creature);
        }
        let spawnLoc = GameState.module.area.getSpawnLocation();
        let facing = -Math.atan2(spawnLoc.rotation.x, spawnLoc.rotation.y);
        switch(index){
          case 0:
            return new EngineLocation(
              spawnLoc.position.x,
              spawnLoc.position.y, 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z
            );
          case 1:
            return new EngineLocation(
              spawnLoc.position.x + 1.5 * Math.cos(facing), 
              spawnLoc.position.y + 1.5 * Math.sin(facing), 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z
            );
          case 2:
            return new EngineLocation(
              spawnLoc.position.x + -1.5 * Math.cos(facing), 
              spawnLoc.position.y + -1.5 * Math.sin(facing), 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z
            );
        }
      }else{
        let index = PartyManager.party.indexOf(creature);
        if(index == -1){
          index = PartyManager.GetCreatureStartingPartyIndex(creature);
        }
        let spawnLoc = GameState.module.area.getSpawnLocation();
        let facing = spawnLoc.getFacing();
        switch(index){
          case 0:
            return new EngineLocation(
              spawnLoc.position.x,
              spawnLoc.position.y, 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z,
            );
          case 1:
            return new EngineLocation(
              spawnLoc.position.x + 1.5 * Math.cos(facing), 
              spawnLoc.position.y + 1.5 * Math.sin(facing), 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z,
            );
          case 2:
            return new EngineLocation(
              spawnLoc.position.x + -1.5 * Math.cos(facing), 
              spawnLoc.position.y + -1.5 * Math.sin(facing), 
              spawnLoc.position.z,
              spawnLoc.rotation.x,
              spawnLoc.rotation.y, 
              spawnLoc.rotation.z,
            );
        }
      }
    }
    
    return GameState.module.area.getSpawnLocation();

  }

  static #tmpFollowPosition = new THREE.Vector3();
  /**
   * Get the follow position of the creature
   * @param creature - The creature to get the follow position of
   * @returns THREE.Vector3
   */
  static GetFollowPosition(creature: ModuleCreature){
    const formation = PartyManager.Formations.get(creature);
    if(formation && BitWise.InstanceOfObject(formation.anchor, ModuleObjectType.ModuleCreature) && !formation.anchor.destroyed){
      return this.GetFormationPosition(creature, formation.anchor, formation.pattern, formation.position);
    }
    return this.GetFollowPositionAtIndex(PartyManager.party.indexOf(creature));
  }

  /**
   * World position of a formation slot around the anchor, snapped to the creature's walkmesh
   */
  static GetFormationPosition(creature: ModuleCreature, anchor: ModuleCreature, pattern: PartyFormationPattern, position: number){
    const offset = PartyManager.GetFormationOffset(pattern, position);
    const facing = anchor.rotation.z;
    this.#tmpFollowPosition.set(
      anchor.position.x + offset.right * Math.cos(facing) - offset.forward * Math.sin(facing),
      anchor.position.y + offset.right * Math.sin(facing) + offset.forward * Math.cos(facing),
      anchor.position.z
    );

    return (creature.area.isPointWalkable(this.#tmpFollowPosition)) ?
      this.#tmpFollowPosition : creature.area.getNearestWalkablePoint(this.#tmpFollowPosition, creature.getHitDistance());
  }

  /**
   * Get the follow position of the creature at the index
   * @param idx - The index of the party member to get the follow position of
   * @returns THREE.Vector3
   */
  static GetFollowPositionAtIndex(idx: number = 1){
    const leader = PartyManager.party[0];
    const creature = PartyManager.party[idx];

    if(!creature)
      return new THREE.Vector3();

    // Party members without an explicit SetFormation stand abreast of the leader: slot 1 left, slot 2 right.
    return this.GetFormationPosition(creature, leader, PartyFormationPattern.LINE, idx);
  }

  /**
   * Give XP to the player
   * @param nXP - The amount of XP to give
   * @returns void
   */
  static GiveXP(nXP = 0){
    this.Player.experience += nXP;
    GameState.UINotificationManager.EnableUINotificationIconType(UIIconTimerType.PLOT_XP_RECEIVED);
  }

  /**
   * Export the party member template
   * @param index - The index of the party member to export
   * @param template - The template to export
   * @returns void
   */
  static async ExportPartyMemberTemplate( index = 0, template: GFFObject ){
    if(!(template instanceof GFFObject)){ return; }
    template.removeFieldByLabel('TemplateResRef');
    await template.export( path.join( CurrentGame.gameinprogress_dir, 'AVAILNPC'+index+'.utc'));
  }

  /**
   * Export the party member templates
   * @returns void
   */
  static async ExportPartyMemberTemplates(){
    return new Promise<void>( async (resolve, reject) => {
      let maxPartyMembers = (GameState.GameKey == GameEngineType.KOTOR) ? 9 : 12;
      for(let i = 0; i < maxPartyMembers; i++){
        let pm = PartyManager.NPCS[i];
        if(!pm){
          continue;
        }

        if(!(pm.template instanceof GFFObject)){
          const shouldWarn = !!(pm.available || pm.canSelect || pm.spawned || pm.moduleObject);
          if(shouldWarn){
            console.warn(`ExportPartyMemberTemplates: Failed to export template for NPC at index [${i}]. template was not an instance of GFFObject`);
          }
          continue;
        }

        await PartyManager.ExportPartyMemberTemplate(i, pm.template);
      }
      for(let i = 0; i < PartyManager.MaxPuppetCount; i++){
        const puppet = PartyManager.Puppets[i];
        if(BitWise.InstanceOfObject(puppet?.moduleObject, ModuleObjectType.ModuleCreature) && !puppet.moduleObject.destroyed){
          puppet.template = puppet.moduleObject.save();
        }
        if(puppet?.template instanceof GFFObject){
          await puppet.template.export( path.join( CurrentGame.gameinprogress_dir, 'AVAILPUP'+i+'.utc'));
        }
      }
      await PartyManager.ExportPlayerCharacter();
      resolve();
    });
  }

  /**
   * Export the player character
   * @returns void
   */
  static async ExportPlayerCharacter(){
    if(GameState.PartyManager.Player instanceof ModuleCreature && (GameState.PartyManager.Player instanceof ModulePlayer || GameState.PartyManager.Player.isPlayer || GameState.PartyManager.Player.npcId < 0)){
      GameState.PartyManager.ActualPlayerTemplate = GameState.PartyManager.Player.save();
    }

    if(!GameState.PartyManager.ActualPlayerTemplate && GameState.PartyManager.PlayerTemplate){
      GameState.PartyManager.ActualPlayerTemplate = GameState.PartyManager.PlayerTemplate;
    }

    if(!GameState.PartyManager.ActualPlayerTemplate){ return; }
    const gff = GameState.PartyManager.ActualPlayerTemplate;
    await gff.export( path.join( CurrentGame.gameinprogress_dir, 'pc.utc'));
  }

  /**
   * Save the party member
   * @param npcId - The NPC ID
   * @returns void
   */
  public static async SavePartyMember(npcId: number = 0){
    const pm = PartyManager.party.find( (pm) => pm.npcId == npcId );
    if(pm) pm.save();
    const npc = PartyManager.NPCS[npcId];
    if(!npc){ return; }
    if(npc.template instanceof GFFObject){
      await PartyManager.ExportPartyMemberTemplate(npcId, npc.template);
    }
  }

  /**
   * Generate the player template
   * @returns GFFObject
   */
  public static GeneratePlayerTemplate(): GFFObject {
    let pTPL = new GFFObject();

    pTPL.RootNode.addField( new GFFField(GFFDataType.DWORD, 'ObjectId') ).setValue( GameState.ModuleObjectManager.GetNextPlayerId() );
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'Appearance_Type') ).setValue(GameState.GameKey == GameEngineType.TSL ? 134 : 177);
    pTPL.RootNode.addField( new GFFField(GFFDataType.CEXOLOCSTRING, 'FirstName') ).setValue(GameState.GameKey == GameEngineType.TSL ? 'Leia Organa' : 'Luke Skywalker');
    pTPL.RootNode.addField( new GFFField(GFFDataType.INT, 'Age') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.SHORT, 'ArmorClass') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'BodyBag') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.FLOAT, 'ChallengeRating') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'FactionID') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'PortraitId') ).setValue(GameState.GameKey == GameEngineType.TSL ? 10 : 26);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'HitPoints') ).setValue(100);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'MaxHitPoints') ).setValue(100);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'CurrentHitPoints') ).setValue(70);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'ForcePoints') ).setValue(15);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'MaxForcePoints') ).setValue(15);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'Commandable') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'CurrentForce') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'DeadSelectable') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'DetectMode') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'Disarmable') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'IsDestroyable') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'IsPC') ).setValue(1);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'IsRaiseable') ).setValue(1);
    let equipment = pTPL.RootNode.addField( new GFFField(GFFDataType.LIST, 'Equip_ItemList') );
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptAttacked') ).setValue('k_hen_attacked01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptDamaged') ).setValue('k_def_damage01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptDeath') ).setValue('');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptDialogue') ).setValue('k_hen_dialogue01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptDisturbed') ).setValue('');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptEndDialogu') ).setValue('');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptEndRound') ).setValue('k_hen_combend01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptHeartbeat') ).setValue('k_hen_heartbt01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptOnBlocked') ).setValue('k_def_blocked01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptOnNotice') ).setValue('k_hen_percept01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptRested') ).setValue('');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptSpawn') ).setValue('k_hen_spawn01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptSpellAt') ).setValue('k_def_spellat01');
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'ScriptUserDefine') ).setValue('k_def_userdef01');

    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'GoodEvil') ).setValue(50);

    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'NaturalAC') ).setValue(0);

    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Con') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Dex') ).setValue(14);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Str') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Wis') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Cha') ).setValue(10);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'Int') ).setValue(10);

    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'fortbonus') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'refbonus') ).setValue(0);
    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'willbonus') ).setValue(0);

    pTPL.RootNode.addField( new GFFField(GFFDataType.BYTE, 'PerceptionRange') ).setValue(12);

    let classList = pTPL.RootNode.addField( new GFFField(GFFDataType.LIST, 'ClassList') );
    for(let i = 0; i < 1; i++){
      let _class = new GFFStruct();
      _class.addField( new GFFField(GFFDataType.INT, 'Class') ).setValue(0);
      _class.addField( new GFFField(GFFDataType.SHORT, 'ClassLevel') ).setValue(1);
      _class.addField( new GFFField(GFFDataType.LIST, 'KnownList0') );
      classList.addChildStruct(_class);
    }

    let skillList = pTPL.RootNode.addField( new GFFField(GFFDataType.LIST, 'SkillList') );

    for(let i = 0; i < 8; i++){
      let _skill = new GFFStruct();
      _skill.addField( new GFFField(GFFDataType.RESREF, 'Rank') ).setValue(0);
      skillList.addChildStruct(_skill);
    }

    let armorStruct = new GFFStruct(ModuleCreatureArmorSlot.ARMOR);
    armorStruct.addField( new GFFField(GFFDataType.RESREF, 'EquippedRes') ).setValue('g_a_jedirobe01');
    let rhStruct = new GFFStruct(ModuleCreatureArmorSlot.RIGHTHAND);
    rhStruct.addField( new GFFField(GFFDataType.RESREF, 'EquippedRes') ).setValue('g_w_lghtsbr01');

    equipment.addChildStruct( armorStruct );
    equipment.addChildStruct( rhStruct );

    // SoundSetFile
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'SoundSetFile') ).setValue(85);
    pTPL.RootNode.addField( new GFFField(GFFDataType.RESREF, 'Race') ).setValue(6);

    /*let spawnLoc = this.getSpawnLocation();
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'XPosition') ).setValue(spawnLoc.XPosition);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'YPosition') ).setValue(spawnLoc.YPosition);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'ZPosition') ).setValue(spawnLoc.ZPosition);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'XOrientation') ).setValue(spawnLoc.XOrientation);
    pTPL.RootNode.addField( new GFFField(GFFDataType.WORD, 'YOrientation') ).setValue(spawnLoc.YOrientation);*/
    PartyManager.PlayerTemplate = pTPL;
    PartyManager.PlayerTemplate.json = PartyManager.PlayerTemplate.toJSON();
    return PartyManager.PlayerTemplate;
  }

  /**
   * Add an event listener
   * @param type - The type of event to add
   * @param cb - The function to call when the event is triggered
   * @returns void
   */
  static AddEventListener(type: PartyManagerEvent, cb: Function){
    if(typeof cb !== 'function'){ return; }

    const events: Function[] = PartyManager.#eventListeners.get(type) || [];
    if(events.indexOf(cb) === -1){
      events.push(cb);
    }

    if(!PartyManager.#eventListeners.has(type)){
      PartyManager.#eventListeners.set(type, events);
    }
  }

  /**
   * Remove an event listener
   * @param type - The type of event to remove
   * @param cb - The function to remove
   * @returns void
   */
  static RemoveEventListener(type: PartyManagerEvent, cb: Function){
    if(!PartyManager.#eventListeners.has(type)){ return; }

    const events: Function[] = PartyManager.#eventListeners.get(type) || [];
    const idx = events.indexOf(cb);
    if(idx >= -1){
      events.splice(idx, 1);
    }
  }

  /**
   * Process an event listener
   * @param type - The type of event to process
   * @param args - The arguments to pass to the event listener
   * @returns void
   */
  static ProcessEventListener(type: PartyManagerEvent, args: any[]){
    const events: Function[] = PartyManager.#eventListeners.get(type) || [];
    for(let i = 0; i < events.length; i++){
      events[i](...args);
    }
  }

}

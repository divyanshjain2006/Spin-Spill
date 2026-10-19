import mongoose from 'mongoose';
const schema=new mongoose.Schema({code:{type:String,unique:true,index:true},state:{type:Object,required:true}},{timestamps:true});
export const RoomModel=mongoose.models.Room||mongoose.model('Room',schema);

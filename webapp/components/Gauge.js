import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, PanResponder, TouchableOpacity } from 'react-native';
import Constants from 'expo-constants';

let Svg=null, Circle=null, Line=null, Path=null, SvgText=null;
try{
  const svg = require('react-native-svg');
  Svg = svg.Svg; Circle = svg.Circle; Line = svg.Line;
  Path = svg.Path; SvgText = svg.Text;
}catch(e){ Svg=null; }

const SENSOR_MIN = 0;
const SENSOR_MAX = 220;
// Color arc defaults (used when caller supplies greenStart/greenEnd or we fall back)
const GREEN_START = 65;
const GREEN_END = 85;

export default function Gauge({ title='Sensor', size=195, sensorValue=null, targetValue=50, onSetTarget=(v)=>{}, id=0, sensorTopic=null, targetTopic=null, greenStart=null, greenEnd=null }){
  const anim = useRef(new Animated.Value(0)).current;
  const needleAnim = useRef(new Animated.Value(0)).current;
  const targetAnim = useRef(new Animated.Value(0)).current;
  const [displayed, setDisplayed] = useState(sensorValue);
  const [targetPct, setTargetPct] = useState(() => {
    const fullRange = SENSOR_MAX - SENSOR_MIN;
    return isFinite(targetValue) ? Math.max(0, Math.min(100, ((targetValue - SENSOR_MIN) / fullRange) * 100)) : 0;
  });
  const [trackWidth, setTrackWidth] = useState(200);
  const [dragPct, setDragPct] = useState(null);
  const trackRef = useRef(null);

  // simplified: no configurable colored bands
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e, gs) => {
      const x = e.nativeEvent.locationX || 0;
      const w = trackWidth || 200;
      const pct = Math.max(0, Math.min(100, (x / w) * 100));
      setDragPct(pct);
    },
    onPanResponderMove: (e, gs) => {
      const x = e.nativeEvent.locationX || 0;
      const w = trackWidth || 200;
      const pct = Math.max(0, Math.min(100, (x / w) * 100));
      setDragPct(pct);
    },
    onPanResponderRelease: (e, gs) => {
      const x = e.nativeEvent.locationX || 0;
      const w = trackWidth || 200;
      const pct = Math.max(0, Math.min(100, (x / w) * 100));
      setDragPct(null);
      const newVal = Math.round(0 + (pct / 100) * (220 - 0));
      try { onSetTarget(newVal); } catch (e) {}
    },
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: () => setDragPct(null),
  })).current;

  useEffect(()=>{ if (sensorValue !== null) setDisplayed(sensorValue); },[sensorValue]);
  useEffect(()=>{
    const pct = displayed === null ? 0 : Math.max(0, Math.min(100, ((displayed - 0) / (220 - 0)) * 100));
    Animated.timing(anim, { toValue: pct, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver:false }).start();
    Animated.timing(needleAnim, { toValue: pct, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver:false }).start();
  },[displayed]);

  // animate target needle when targetValue changes
  useEffect(() => {
    const fullRange = SENSOR_MAX - SENSOR_MIN;
    const pct = isFinite(targetValue) ? Math.max(0, Math.min(100, ((targetValue - SENSOR_MIN) / fullRange) * 100)) : 0;
    Animated.timing(targetAnim, { toValue: pct, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    const id = targetAnim.addListener(({ value }) => setTargetPct(value));
    // ensure initial set in case listener doesn't fire immediately
    setTargetPct(pct);
    return () => { targetAnim.removeListener(id); };
  }, [targetValue]);

  const handleTrackPress = (e) => {
    const lx = e.nativeEvent.locationX || 0;
    const w = trackWidth || 200;
    const ratio = Math.max(0, Math.min(1, lx / (w || 200)));
    const newVal = Math.round(0 + ratio * (220 - 0));
    onSetTarget(newVal);
  };

  const pct = displayed === null ? 0 : Math.max(0, Math.min(100, ((displayed - 0) / (220 - 0)) * 100));
  // horizontal padding so outermost labels aren't clipped; make the gauge slightly wider
  const PAD = Math.max(12, Math.round(size * 0.12));
  const containerWidth = Math.round(size * 1.12) + PAD * 2; // slightly wider than requested size
  // give extra vertical room so the top of the arc and label ticks are never clipped
  // Shrink container height to pull everything (especially numeric value) closer to the Target label below
  // Compact height while keeping tick labels readable; we'll place numeric almost directly under arc
  // Add more vertical room to prevent top tick clipping while keeping lower gap tight
  // slightly increase height to accommodate inline slider inside gauge container
  const containerHeight = Math.round(size + 80);

  return (
    <View style={{ alignItems:'center', marginVertical:6, width: '100%', alignSelf: 'center', paddingBottom:4, marginBottom:4 }}>
  <Text style={{ fontSize:16, fontWeight:'700', marginBottom:4, marginTop:-8, backgroundColor:'transparent' }}>{title}</Text>
    {Svg ? (
  // SVG gauge container with inline slider overlay
  <View style={{ width: containerWidth, height: containerHeight, alignItems:'center', justifyContent:'flex-start', overflow: 'visible', paddingTop:4 }}>
  <Svg width={containerWidth} height={containerHeight} viewBox={`0 0 ${containerWidth} ${containerHeight}`}>
            {(() => {
                          const s = size;
                          const strokeW = Math.max(8, Math.round(s * 0.08));
                          // Shift the drawing origin by PAD so the arc centers inside the padded viewBox
                          const cx = Math.round(containerWidth / 2);
                          // position the arc so there's visible space above it and the bottom of the arc sits
                          // close to the numeric temperature; cy near 46% of container works well for many sizes
                          // Move the arc slightly upward (smaller multiplier) so the bottom space is reduced
                          // Center arc with minimal top padding; 0.43 balances headroom and room for numeric + Target below
                          // Lower arc slightly (higher ratio) to reveal full top ticks and labels
                          const cy = Math.round(containerHeight * 0.48);
                          const r = Math.round(Math.min(s/2, containerHeight * 0.46) - strokeW - 8);
                          // sweep is 220°; set start so value 0 maps toward the bottom-left (240°) so 0 sits lower
                          // Flip the semicircle upside-down by starting at 180° and sweeping 180° -> 360° (visual flip)
                          const SWEEP_DEG = 180;
                          const SWEEP_START = 180; // start at 180° so the semicircle is flipped
                          const SWEEP_END = SWEEP_START + SWEEP_DEG; // sweep end at 360°/0°

                          const toXY = (centerX, centerY, radius, deg) => {
                            const rad = (deg * Math.PI) / 180;
                            return { x: centerX + Math.cos(rad) * radius, y: centerY + Math.sin(rad) * radius };
                          };

                          // helper: describe an arc from angle a1 to a2 at radius r
                          const describeArc = (cx0, cy0, radius, a1, a2) => {
                            const start = toXY(cx0, cy0, radius, a1);
                            const end = toXY(cx0, cy0, radius, a2);
                            // large-arc-flag is 0 because our sweep < 360
                            const largeArcFlag = (a2 - a1) <= 180 ? '0' : '1';
                            const d = `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
                            return d;
                          };

                          // Determine zones: if explicitly given (greenStart/greenEnd) use them; else fallback to defaults;
                          // Plain mode (neutral arc) occurs only when band covers full range (0..220)
                          const useGreenStart = typeof greenStart === 'number' ? greenStart : GREEN_START;
                          const useGreenEnd = typeof greenEnd === 'number' ? greenEnd : GREEN_END;
                          const plainMode = (useGreenStart === 0 && useGreenEnd === SENSOR_MAX);
                          const blueMax = useGreenStart - 1e-9;
                          const greenMax = useGreenEnd + 1e-9;
                          const fullRange = SENSOR_MAX - SENSOR_MIN;
                          const valueToAngle = (v) => {
                            const clamped = Math.max(SENSOR_MIN, Math.min(SENSOR_MAX, v));
                            const ratio = (clamped - SENSOR_MIN) / fullRange;
                            return SWEEP_START + ratio * SWEEP_DEG;
                          };

                          // small overlap (degrees) between adjacent arcs to avoid 1-pixel gaps on some renderers
                          const EPS_DEG = 3.0;
                          const blueStartA = SWEEP_START;
                          const blueEndA = Math.min(SWEEP_END, valueToAngle(blueMax) + EPS_DEG);
                          const greenStartA = Math.max(SWEEP_START, valueToAngle(blueMax) - EPS_DEG);
                          const greenEndA = Math.min(SWEEP_END, valueToAngle(greenMax) + EPS_DEG);
                          const redStartA = Math.max(SWEEP_START, valueToAngle(greenMax) - EPS_DEG);
                          const redEndA = SWEEP_END;

                          // needle position
                          const animatedPct = typeof needleAnim.__getValue === 'function' ? needleAnim.__getValue() / 100 : pct / 100;
                          const angle = SWEEP_START + animatedPct * SWEEP_DEG;
                          const nr = r - strokeW * 0.5 - 4;
                          const nx = cx + Math.cos((angle * Math.PI) / 180) * nr; const ny = cy + Math.sin((angle * Math.PI) / 180) * nr;
                          const backx = cx - Math.cos((angle * Math.PI) / 180) * 8; const backy = cy - Math.sin((angle * Math.PI) / 180) * 8;
                          // ticks every 20 degrees 0..220
                          const ticks = [];
                          for (let t=0;t<=220;t+=20) ticks.push(t);
                          const tickInner = r - strokeW - 6;
                          const tickOuter = r + strokeW * 0.4 + 4;
                          const labelRadius = r + strokeW * 0.9 + 8;
              return (
                <>
                  {/* Draw only the sweep arc background (do not draw full circles) to avoid reserving the lower half */}
                  <Path d={describeArc(cx, cy, r, SWEEP_START, SWEEP_END)} stroke="#f5f6f7" strokeWidth={strokeW + 2} strokeLinecap="butt" fill="none" />
                  {plainMode ? (
                    <Path d={describeArc(cx, cy, r, SWEEP_START, SWEEP_END)} stroke="#cccccc" strokeWidth={strokeW + 2} strokeLinecap="butt" fill="none" />
                  ) : (
                    <>
                      {/* blue arc */}
                      {blueEndA > blueStartA && (
                        <Path d={describeArc(cx, cy, r, blueStartA, blueEndA)} stroke="#1237cc" strokeWidth={strokeW + 2} strokeLinecap="butt" fill="none" />
                      )}
                      {/* green arc */}
                      {greenEndA > greenStartA && (
                        <Path d={describeArc(cx, cy, r, greenStartA, greenEndA)} stroke="#2e7d32" strokeWidth={strokeW + 2} strokeLinecap="butt" fill="none" />
                      )}
                      {/* red arc */}
                      {redEndA > redStartA && (
                        <Path d={describeArc(cx, cy, r, redStartA, redEndA)} stroke="#c62828" strokeWidth={strokeW + 2} strokeLinecap="butt" fill="none" />
                      )}
                    </>
                  )}
                  {/* ticks and numeric labels */}
                  {ticks.map((t, idx) => {
                    const a = valueToAngle(t);
                    const inPt = toXY(cx, cy, tickInner, a);
                    const outPt = toXY(cx, cy, tickOuter, a);
                    const lab = toXY(cx, cy, labelRadius, a);
                    const fontSize = Math.max(8, Math.round(s * 0.06));
                    return (
                      <React.Fragment key={`tick-${t}`}>
                        <Line x1={inPt.x} y1={inPt.y} x2={outPt.x} y2={outPt.y} stroke="rgba(0,0,0,0.16)" strokeWidth={1} strokeLinecap="round" />
                        <SvgText x={lab.x} y={lab.y} fontSize={Math.max(8, Math.round(fontSize * 0.85))} fill="rgba(0,0,0,0.5)" textAnchor="middle" alignmentBaseline="middle">{String(t)}</SvgText>
                      </React.Fragment>
                    );
                  })}
                      {/* target indicator: small thin needle */}
                      {typeof targetValue === 'number' && !Number.isNaN(targetValue) && (
                        (() => {
                          const tPct = (typeof targetPct === 'number') ? targetPct : (isFinite(targetValue) ? Math.max(0, Math.min(100, ((targetValue - SENSOR_MIN) / fullRange) * 100)) : 0);
                          const tValue = SENSOR_MIN + (tPct / 100) * fullRange;
                          const tAngle = valueToAngle(tValue);
                          const tr = nr * 0.78; // slightly shorter than main needle
                          const tx = cx + Math.cos((tAngle * Math.PI) / 180) * tr;
                          const ty = cy + Math.sin((tAngle * Math.PI) / 180) * tr;
                          return (
                            <>
                              <Line x1={cx} y1={cy} x2={tx} y2={ty} stroke="#ff9800" strokeWidth={2} strokeLinecap="round" />
                              <Circle cx={tx} cy={ty} r={3} fill="#ff9800" />
                            </>
                          );
                        })()
                      )}
                  <Line x1={backx} y1={backy} x2={nx} y2={ny} stroke="#000" strokeWidth={Math.max(2, Math.round(strokeW*0.35))} strokeLinecap="round" />
                  <Line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#1565c0" strokeWidth={Math.max(1, Math.round(strokeW*0.22))} strokeLinecap="round" />
                  <Circle cx={cx} cy={cy} r={Math.max(3, Math.round(strokeW*0.25))} fill="#000" />
                  {/* numeric value as SVG text placed just below the arc so it hugs the gauge */}
                  {(() => {
                    const fontSize = Math.max(12, Math.round(s * 0.11));
                    const y = cy + Math.round(r * 0.55);
                    return (
                      <>
                        <SvgText x={cx} y={y} fontSize={fontSize} fill="#111" textAnchor="middle" alignmentBaseline="middle">{displayed === null ? '—' : `${displayed.toFixed(1)}°`}</SvgText>
                        <SvgText x={cx} y={y + fontSize * 0.85} fontSize={Math.round(fontSize * 0.65)} fill="#444" textAnchor="middle" alignmentBaseline="hanging">
                          Target: {targetValue === null || targetValue === undefined ? '—' : targetValue}°
                        </SvgText>
                      </>
                    );
                  })()}
                    </>
                  );
                })()}
              </Svg>
            {/* Inline slider overlay inside gauge container */}
            <View style={{ position:'absolute', left: PAD, right: PAD, bottom: 8, flexDirection:'row', alignItems:'center', justifyContent:'center' }}>
              {/* decrement */}
              <TouchableOpacity onPress={() => { try { const nv = Math.max(SENSOR_MIN, Math.round((targetValue||0) - 1)); onSetTarget(nv); } catch(e){} }} style={{ width:28, alignItems:'center', justifyContent:'center', paddingVertical:4 }}>
                <Text style={{ fontSize:16, color:'rgba(0,0,0,0.55)' }}>{'◀'}</Text>
              </TouchableOpacity>
              <View ref={trackRef} style={{ flex:1, marginHorizontal:8, position: 'relative' }} onLayout={(e)=>setTrackWidth(e.nativeEvent.layout.width)} {...panResponder.panHandlers}>
                <View style={{ height:28, backgroundColor:'rgba(0,0,0,0.05)', borderRadius:14, overflow:'visible', justifyContent:'center', borderWidth:1, borderColor:'rgba(0,0,0,0.08)', paddingHorizontal:8 }}>
                  {(() => {
                    const safePct = (dragPct !== null)
                      ? Math.max(0, Math.min(100, dragPct))
                      : (typeof targetValue === 'number' && !Number.isNaN(targetValue)
                          ? Math.max(0, Math.min(100, (targetValue / SENSOR_MAX) * 100))
                          : 0);
                    const currentValue = (dragPct !== null) 
                      ? Math.round(SENSOR_MIN + (dragPct / 100) * (SENSOR_MAX - SENSOR_MIN))
                      : (targetValue || 0);
                    
                    return (
                      <>
                        <View style={{ width: `${safePct}%`, height:10, backgroundColor:'#2196f3', borderRadius:6 }} />
                        {/* Position indicator bubble */}
                        <View style={{ 
                          position: 'absolute', 
                          left: `${Math.max(8, Math.min(92, safePct))}%`, 
                          top: -32,
                          alignItems: 'center',
                          opacity: dragPct !== null ? 1 : 0,
                          transform: [{ translateX: -12 }]
                        }}>
                          {/* Bubble background */}
                          <View style={{
                            backgroundColor: '#2196f3',
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 8,
                            minWidth: 32,
                            alignItems: 'center',
                            shadowColor: '#000',
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: 0.25,
                            shadowRadius: 4,
                            elevation: 5
                          }}>
                            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>
                              {currentValue}°
                            </Text>
                          </View>
                          {/* Bubble pointer */}
                          <View style={{
                            width: 0,
                            height: 0,
                            borderLeftWidth: 6,
                            borderRightWidth: 6,
                            borderTopWidth: 6,
                            borderLeftColor: 'transparent',
                            borderRightColor: 'transparent',
                            borderTopColor: '#2196f3',
                            marginTop: -1
                          }} />
                        </View>
                        {/* Track thumb */}
                        <View style={{
                          position: 'absolute',
                          left: `${safePct}%`,
                          top: '50%',
                          width: 18,
                          height: 18,
                          borderRadius: 9,
                          backgroundColor: '#2196f3',
                          borderWidth: 2,
                          borderColor: '#fff',
                          transform: [{ translateX: -9 }, { translateY: -9 }],
                          shadowColor: '#000',
                          shadowOffset: { width: 0, height: 1 },
                          shadowOpacity: 0.2,
                          shadowRadius: 2,
                          elevation: 3
                        }} />
                      </>
                    );
                  })()}
                </View>
              </View>
              {/* increment */}
              <TouchableOpacity onPress={() => { try { const nv = Math.min(SENSOR_MAX, Math.round((targetValue||0) + 1)); onSetTarget(nv); } catch(e){} }} style={{ width:28, alignItems:'center', justifyContent:'center', paddingVertical:4 }}>
                <Text style={{ fontSize:16, color:'rgba(0,0,0,0.55)' }}>{'▶'}</Text>
              </TouchableOpacity>
            </View>
            </View>
      ) : (
        <View style={{ width: size, height: 24, backgroundColor:'#eee', borderRadius:12, overflow:'hidden' }}>
          <View style={{ width: `${pct}%`,  backgroundColor:'#1237cc' }} />
        </View>
      )}

  {/* external slider and divider removed; slider now inside gauge */}
  </View>
  );
}

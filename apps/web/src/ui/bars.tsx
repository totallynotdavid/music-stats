export function DayBars({ days }: { days: { day: string; plays: number }[] }) {
  const max = Math.max(1, ...days.map((day) => day.plays));
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return (
    <>
      <div class="daily" role="list" aria-label="Plays per day">
        {days.map((day) => (
          <span
            class="bar"
            role="listitem"
            key={day.day}
            style={`height: ${(day.plays / max) * 100}%`}
            title={`${day.day}: ${day.plays} plays`}
            aria-label={`${day.day}: ${day.plays} plays`}
          />
        ))}
      </div>
      <div class="axis">
        <span>{first.day}</span>
        <span>{last.day}</span>
      </div>
    </>
  );
}

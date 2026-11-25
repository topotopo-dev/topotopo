// Copyright 2026 faxcorp, Apache-2.0
#include "TopoTopoStream.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include <charconv>
#include <cmath>

namespace
{
struct FColumn
{
    FString Name;
    ETopoTopoAttributeType Type = ETopoTopoAttributeType::Float;
    int32 Size = 1;
    TArray<double> Numbers;
    TArray<FString> Strings;
};

struct FCell
{
    FString Text;
    bool bQuoted = false;
};

bool Fail(FString& Error, const FString& Message)
{
    Error = Message;
    return false;
}

bool Number(const FString& Text, double& Value)
{
    const FString Trimmed = Text.TrimStartAndEnd();
    if (Trimmed.IsEmpty()) return false;
    // from_chars consumes a complete ASCII number without consulting the process locale.
    const auto ASCII = StringCast<ANSICHAR>(*Trimmed);
    const ANSICHAR* Begin = ASCII.Get();
    const ANSICHAR* End = Begin + ASCII.Length();
    if (Begin != End && *Begin == '+')
    {
        ++Begin;
        if (Begin == End || *Begin == '-') return false;
    }
    const auto Parsed = std::from_chars(Begin, End, Value, std::chars_format::general);
    return Parsed.ec == std::errc() && Parsed.ptr == End && FMath::IsFinite(Value);
}

bool IntegerName(const FString& Name)
{
    return Name == TEXT("id") || Name == TEXT("class") || Name == TEXT("seed") ||
        Name == TEXT("copynum") || Name == TEXT("piece") || Name == TEXT("variant") ||
        Name == TEXT("ptnum") || Name == TEXT("primnum") || Name == TEXT("Seed");
}

bool ParseCSV(const FString& Text, TArray<TArray<FCell>>& Rows, FString& Error)
{
    // Detect delimiter outside quotes in the header, then parse RFC 4180 including embedded newlines.
    int32 Counts[3] = {0, 0, 0};
    const TCHAR Delimiters[3] = {TEXT(','), TEXT(';'), TEXT('\t')};
    bool bInQuotes = false;
    for (int32 Index = 0; Index < Text.Len(); ++Index)
    {
        const TCHAR C = Text[Index];
        if (C == TEXT('"')) bInQuotes = !bInQuotes;
        if (!bInQuotes && (C == TEXT('\r') || C == TEXT('\n'))) break;
        if (!bInQuotes) for (int32 D = 0; D < 3; ++D) if (C == Delimiters[D]) ++Counts[D];
    }
    int32 Best = 0;
    for (int32 D = 1; D < 3; ++D) if (Counts[D] > Counts[Best]) Best = D;
    const TCHAR Delimiter = Delimiters[Best];
    TArray<FCell> Row;
    FCell Cell;
    bInQuotes = false;
    bool bAfterQuote = false;
    auto EndCell = [&]()
    {
        if (!Cell.bQuoted) Cell.Text.TrimStartAndEndInline();
        Row.Add(MoveTemp(Cell));
        Cell = FCell();
        bAfterQuote = false;
    };
    auto EndRow = [&]()
    {
        EndCell();
        if (Row.Num() > 1 || !Row[0].Text.IsEmpty()) Rows.Add(MoveTemp(Row));
        Row.Reset();
    };
    for (int32 Index = 0; Index < Text.Len(); ++Index)
    {
        const TCHAR C = Text[Index];
        if (Index == 0 && C == 0xfeff) continue;
        if (bInQuotes)
        {
            if (C == TEXT('"'))
            {
                if (Index + 1 < Text.Len() && Text[Index + 1] == TEXT('"')) { Cell.Text.AppendChar(C); ++Index; }
                else { bInQuotes = false; bAfterQuote = true; }
            }
            else Cell.Text.AppendChar(C);
        }
        else if (C == Delimiter) EndCell();
        else if (C == TEXT('\r') || C == TEXT('\n'))
        {
            EndRow();
            if (C == TEXT('\r') && Index + 1 < Text.Len() && Text[Index + 1] == TEXT('\n')) ++Index;
        }
        else if (C == TEXT('"'))
        {
            if (!Cell.Text.TrimStartAndEnd().IsEmpty() || bAfterQuote)
                return Fail(Error, FString::Printf(TEXT("CSV row %d: unexpected quote."), Rows.Num() + 1));
            Cell.Text.Empty(); Cell.bQuoted = true; bInQuotes = true;
        }
        else if (bAfterQuote)
        {
            if (!FChar::IsWhitespace(C)) return Fail(Error, TEXT("CSV: characters after a closing quote; quote the entire cell."));
        }
        else Cell.Text.AppendChar(C);
    }
    if (bInQuotes) return Fail(Error, TEXT("CSV ends inside a quoted field."));
    if (!Cell.Text.IsEmpty() || Cell.bQuoted || !Row.IsEmpty()) EndRow();
    if (Rows.IsEmpty()) return Fail(Error, TEXT("CSV is empty; a position header is required."));
    for (int32 Index = 1; Index < Rows.Num(); ++Index)
        if (Rows[Index].Num() != Rows[0].Num())
            return Fail(Error, FString::Printf(TEXT("CSV row %d: expected %d cells, found %d."), Index + 1, Rows[0].Num(), Rows[Index].Num()));
    return true;
}

int32 ComponentIndex(const FString& Component)
{
    const FString Lower = Component.ToLower();
    if (Lower == TEXT("x") || Lower == TEXT("r") || Lower == TEXT("roll")) return 0;
    if (Lower == TEXT("y") || Lower == TEXT("g") || Lower == TEXT("pitch")) return 1;
    if (Lower == TEXT("z") || Lower == TEXT("b") || Lower == TEXT("yaw")) return 2;
    if (Lower == TEXT("w") || Lower == TEXT("a")) return 3;
    if (!Lower.IsEmpty() && Lower.IsNumeric() && !Lower.Contains(TEXT("."))) return FCString::Atoi(*Lower);
    return INDEX_NONE;
}

bool ParseStruct(const FString& Text, TMap<FString, double>& Values)
{
    const FString Trimmed = Text.TrimStartAndEnd();
    if (!Trimmed.StartsWith(TEXT("(")) || !Trimmed.EndsWith(TEXT(")"))) return false;
    TArray<FString> Parts;
    Trimmed.Mid(1, Trimmed.Len() - 2).ParseIntoArray(Parts, TEXT(","), false);
    for (const FString& Part : Parts)
    {
        FString Key, Value;
        double Numeric = 0;
        if (!Part.Split(TEXT("="), &Key, &Value) || !Number(Value, Numeric)) return false;
        Key = Key.TrimStartAndEnd().ToLower();
        if (Values.Contains(Key)) return false;
        Values.Add(Key, Numeric);
    }
    return !Values.IsEmpty();
}

bool CSVColumns(const FString& Text, TArray<FColumn>& Columns, int32& Count, bool& bPCG, TArray<FString>& Warnings, FString& Error)
{
    TArray<TArray<FCell>> Rows;
    if (!ParseCSV(Text, Rows, Error)) return false;
    Count = Rows.Num() - 1;
    const TArray<FCell>& Header = Rows[0];
    bPCG = Header.ContainsByPredicate([](const FCell& C)
    {
        const FString Name = C.Text.TrimStartAndEnd();
        return Name.Equals(TEXT("Position.X"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("Position"), ESearchCase::IgnoreCase);
    });
    const bool bCanonicalRowKey = bPCG && Header.ContainsByPredicate([](const FCell& C)
    {
        return C.Text.TrimStartAndEnd().Equals(TEXT("Name"), ESearchCase::CaseSensitive);
    });
    struct FGroup { FString Name; FString OutputName; int32 Scalar = INDEX_NONE; TMap<int32, int32> Components; };
    TArray<FGroup> Groups;
    TArray<FString> HeaderNames;
    for (int32 H = 0; H < Header.Num(); ++H)
    {
        const FString Name = Header[H].Text.TrimStartAndEnd();
        if (Name.IsEmpty()) return Fail(Error, TEXT("CSV has an empty column name."));
        // FString equality and hashing ignore case. Preserve distinct source columns until we can
        // choose the exact canonical spelling, independent of their order in the header.
        if (HeaderNames.ContainsByPredicate([&](const FString& Existing) { return Existing.Equals(Name, ESearchCase::CaseSensitive); }))
            return Fail(Error, FString::Printf(TEXT("Duplicate CSV column '%s'."), *Name));
        HeaderNames.Add(Name);
        // Exact Name is the row key even after column reordering. A lone first-column name alias
        // remains accepted, but name next to Name is real metadata and must not be discarded.
        if (bPCG && (Name.Equals(TEXT("Name"), ESearchCase::CaseSensitive) || (H == 0 &&
            ((!bCanonicalRowKey && Name.Equals(TEXT("Name"), ESearchCase::IgnoreCase)) || Name == TEXT("---") || Name.Equals(TEXT("RowName"), ESearchCase::IgnoreCase))))) continue;
        FString Base = Name, Suffix;
        int32 Component = INDEX_NONE;
        if (Name.Split(TEXT("."), &Base, &Suffix, ESearchCase::CaseSensitive, ESearchDir::FromEnd))
        {
            Component = ComponentIndex(Suffix);
            if (Component < 0) Base = Name;
        }
        else if (Name.EndsWith(TEXT("]")))
        {
            FString Tail;
            if (Name.Split(TEXT("["), &Base, &Tail, ESearchCase::CaseSensitive, ESearchDir::FromEnd)) Component = ComponentIndex(Tail.LeftChop(1));
            if (Component < 0) Base = Name;
        }
        else if (Name.Equals(TEXT("x"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("y"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("z"), ESearchCase::IgnoreCase))
        {
            Base = TEXT("P"); Component = ComponentIndex(Name);
        }
        if (Component > 15) return Fail(Error, FString::Printf(TEXT("Column '%s': only tuple components 0..15 are supported."), *Name));
        FGroup* Group = Groups.FindByPredicate([&](const FGroup& G) { return G.Name.Equals(Base, ESearchCase::CaseSensitive); });
        if (!Group) { FGroup NewGroup; NewGroup.Name = Base; NewGroup.OutputName = Base; Groups.Add(MoveTemp(NewGroup)); Group = &Groups.Last(); }
        if (Component < 0) Group->Scalar = H;
        else
        {
            if (Group->Components.Contains(Component)) return Fail(Error, FString::Printf(TEXT("Duplicate component of '%s'."), *Base));
            Group->Components.Add(Component, H);
        }
    }
    TSet<FName> ReservedNames;
    for (const FGroup& Group : Groups) ReservedNames.Add(FName(*Group.Name));
    for (const TCHAR* Canonical : {TEXT("Name"), TEXT("Position"), TEXT("Rotation"), TEXT("Scale"), TEXT("Density"), TEXT("Color"), TEXT("Seed"), TEXT("Mesh")})
    {
        // Native CSV still has a canonical Mesh attribute, but its transform names (scale, seed,
        // etc.) have their own meaning and must not be treated as PCG properties.
        if (!bPCG && FCString::Strcmp(Canonical, TEXT("Mesh")) != 0) continue;
        const bool bHasCanonical = (bCanonicalRowKey && FCString::Strcmp(Canonical, TEXT("Name")) == 0) ||
            Groups.ContainsByPredicate([&](const FGroup& G) { return G.Name.Equals(Canonical, ESearchCase::CaseSensitive); });
        if (!bHasCanonical) continue;
        for (FGroup& Group : Groups)
        {
            if (!Group.Name.Equals(Canonical, ESearchCase::IgnoreCase) || Group.Name.Equals(Canonical, ESearchCase::CaseSensitive)) continue;
            const FString Renamed = Group.Name + TEXT("_attr");
            if (ReservedNames.Contains(FName(*Renamed)))
                return Fail(Error, FString::Printf(TEXT("CSV attribute '%s' collides with canonical '%s', but '%s' already exists (case-insensitive). Rename the input attribute to preserve both values."), *Group.Name, Canonical, *Renamed));
            ReservedNames.Add(FName(*Renamed));
            Group.OutputName = Renamed;
            Warnings.Add(FString::Printf(TEXT("CSV attribute '%s' collides case-insensitively with canonical '%s'; imported as '%s'."), *Group.Name, Canonical, *Renamed));
        }
    }
    TSet<FName> OutputNames;
    for (const FGroup& Group : Groups)
    {
        const FName Name(*Group.OutputName);
        if (OutputNames.Contains(Name))
            return Fail(Error, FString::Printf(TEXT("CSV attributes collide case-insensitively at '%s'. Use the exact canonical spelling for PCG properties or rename the input attribute."), *Group.OutputName));
        OutputNames.Add(Name);
    }
    for (const FGroup& Group : Groups)
    {
        FColumn Column;
        Column.Name = Group.OutputName;
        const bool bStruct = bPCG && Group.Scalar >= 0 && (Column.Name.Equals(TEXT("Position"), ESearchCase::IgnoreCase) || Column.Name.Equals(TEXT("Rotation"), ESearchCase::IgnoreCase) || Column.Name.Equals(TEXT("Scale"), ESearchCase::IgnoreCase) || Column.Name.Equals(TEXT("Color"), ESearchCase::IgnoreCase));
        if (Group.Scalar >= 0 && !Group.Components.IsEmpty()) return Fail(Error, FString::Printf(TEXT("'%s' mixes scalar/struct and component columns."), *Group.Name));
        if (bStruct)
        {
            Column.Size = Group.Name.Equals(TEXT("Color"), ESearchCase::IgnoreCase) ? 4 : 3;
            for (int32 R = 1; R < Rows.Num(); ++R)
            {
                TMap<FString, double> Values;
                if (!ParseStruct(Rows[R][Group.Scalar].Text, Values)) return Fail(Error, FString::Printf(TEXT("CSV row %d '%s': expected Unreal struct text, e.g. (X=1,Y=2,Z=3)."), R + 1, *Group.Name));
                const bool bRotation = Group.Name.Equals(TEXT("Rotation"), ESearchCase::IgnoreCase);
                const bool bColorRGBA = Group.Name.Equals(TEXT("Color"), ESearchCase::IgnoreCase) && Values.Contains(TEXT("r"));
                const TCHAR* XYZ[] = {TEXT("x"), TEXT("y"), TEXT("z"), TEXT("w")};
                const TCHAR* Rot[] = {TEXT("roll"), TEXT("pitch"), TEXT("yaw")};
                const TCHAR* RGBA[] = {TEXT("r"), TEXT("g"), TEXT("b"), TEXT("a")};
                for (int32 C = 0; C < Column.Size; ++C)
                {
                    const TCHAR* Key = bRotation ? Rot[C] : bColorRGBA ? RGBA[C] : XYZ[C];
                    const double* Value = Values.Find(Key);
                    if (!Value) return Fail(Error, FString::Printf(TEXT("CSV row %d '%s': missing component %s."), R + 1, *Group.Name, Key));
                    Column.Numbers.Add(*Value);
                }
            }
        }
        else if (Group.Scalar >= 0)
        {
            bool bNumeric = true, bInteger = IntegerName(Group.Name);
            for (int32 R = 1; R < Rows.Num(); ++R)
            {
                double Value = 0;
                const FCell& Cell = Rows[R][Group.Scalar];
                const bool bCellNumeric = Number(Cell.Text, Value);
                bNumeric &= bCellNumeric && !Cell.bQuoted;
                bInteger &= bCellNumeric && std::floor(Value) == Value && std::abs(Value) <= 9007199254740991.0;
                Column.Numbers.Add(Value);
                Column.Strings.Add(Cell.Text);
            }
            if (Group.Name == TEXT("Mesh") || Group.Name == TEXT("name") || Group.Name == TEXT("material")) bNumeric = false;
            Column.Type = bNumeric ? (bInteger ? ETopoTopoAttributeType::Integer : ETopoTopoAttributeType::Float) : ETopoTopoAttributeType::String;
        }
        else
        {
            Column.Size = 0;
            for (const auto& Pair : Group.Components) Column.Size = FMath::Max(Column.Size, Pair.Key + 1);
            if (Column.Size != Group.Components.Num()) return Fail(Error, FString::Printf(TEXT("'%s' has incomplete tuple components; supply every component from X/0 onward."), *Group.Name));
            for (int32 R = 1; R < Rows.Num(); ++R)
            {
                for (int32 C = 0; C < Column.Size; ++C)
                {
                    double Value = 0;
                    if (!Number(Rows[R][Group.Components[C]].Text, Value)) return Fail(Error, FString::Printf(TEXT("CSV row %d '%s' component %d must be a finite number."), R + 1, *Group.Name, C));
                    Column.Numbers.Add(Value);
                }
            }
        }
        Columns.Add(MoveTemp(Column));
    }
    return true;
}

bool JSONColumns(const FString& Text, TArray<FColumn>& Columns, int32& Count, FString& Error)
{
    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return Fail(Error, TEXT("Invalid points JSON: ") + Reader->GetErrorMessage());
    FString Format;
    double Version = 0, NumberOfRows = 0;
    if (!Root->TryGetStringField(TEXT("format"), Format) || (Format != TEXT("topotopo-points") && Format != TEXT("polyforge-points")) || !Root->TryGetNumberField(TEXT("version"), Version) || Version != 1)
        return Fail(Error, TEXT("Expected format 'topotopo-points', version 1 (legacy 'polyforge-points' is accepted)."));
    if (!Root->TryGetNumberField(TEXT("count"), NumberOfRows) || !FMath::IsFinite(NumberOfRows) || NumberOfRows < 0 || NumberOfRows > MAX_int32 || std::floor(NumberOfRows) != NumberOfRows)
        return Fail(Error, TEXT("points.json count must be a nonnegative 32-bit integer."));
    Count = static_cast<int32>(NumberOfRows);
    const TSharedPtr<FJsonObject>* Attributes = nullptr;
    if (!Root->TryGetObjectField(TEXT("attributes"), Attributes)) return Fail(Error, TEXT("points.json needs an attributes object."));
    TArray<FString> Names;
    for (const auto& Pair : (*Attributes)->Values) Names.Add(FString(*Pair.Key));
    Names.Sort();
    for (const FString& Name : Names)
    {
        const TSharedPtr<FJsonObject>* Spec = nullptr;
        if (!(*Attributes)->TryGetObjectField(Name, Spec)) return Fail(Error, FString::Printf(TEXT("Attribute '%s' must be an object."), *Name));
        FString Type;
        double Size = 0;
        const TArray<TSharedPtr<FJsonValue>>* Data = nullptr;
        if (!(*Spec)->TryGetStringField(TEXT("type"), Type) || (Type != TEXT("float") && Type != TEXT("int") && Type != TEXT("string")) ||
            !(*Spec)->TryGetNumberField(TEXT("size"), Size) || Size < 1 || Size > 16 || std::floor(Size) != Size ||
            !(*Spec)->TryGetArrayField(TEXT("data"), Data) || (Type == TEXT("string") && Size != 1))
            return Fail(Error, FString::Printf(TEXT("Attribute '%s': expected type float/int/string, size 1..16 (string size 1), and flat data array."), *Name));
        FColumn Column;
        Column.Name = Name;
        Column.Size = static_cast<int32>(Size);
        Column.Type = Type == TEXT("string") ? ETopoTopoAttributeType::String : Type == TEXT("int") ? ETopoTopoAttributeType::Integer : ETopoTopoAttributeType::Float;
        if (static_cast<int64>(Count) * Column.Size != Data->Num()) return Fail(Error, FString::Printf(TEXT("Attribute '%s': data length %d differs from count (%d) times size (%d)."), *Name, Data->Num(), Count, Column.Size));
        for (int32 Index = 0; Index < Data->Num(); ++Index)
        {
            if (Column.Type == ETopoTopoAttributeType::String)
            {
                FString Value;
                if ((*Data)[Index]->Type != EJson::String || !(*Data)[Index]->TryGetString(Value)) return Fail(Error, FString::Printf(TEXT("Attribute '%s' data[%d] must be a string."), *Name, Index));
                Column.Strings.Add(MoveTemp(Value));
            }
            else
            {
                double Value = 0;
                if ((*Data)[Index]->Type != EJson::Number || !(*Data)[Index]->TryGetNumber(Value) || !FMath::IsFinite(Value)) return Fail(Error, FString::Printf(TEXT("Attribute '%s' data[%d] must be finite numeric data."), *Name, Index));
                if (Column.Type == ETopoTopoAttributeType::Integer && (std::floor(Value) != Value || Value < MIN_int32 || Value > MAX_int32)) return Fail(Error, FString::Printf(TEXT("Attribute '%s' data[%d] must be an int32."), *Name, Index));
                Column.Numbers.Add(Value);
            }
        }
        Columns.Add(MoveTemp(Column));
    }
    return true;
}

// Column-major 3x3 with the literal operation order of math.ts (not Unreal's row-vector matrices).
struct FBasis
{
    FVector Axis[3] = {FVector(1, 0, 0), FVector(0, 1, 0), FVector(0, 0, 1)};
};

FBasis QuaternionBasis(const FQuat& Q)
{
    FBasis B;
    const double X = Q.X, Y = Q.Y, Z = Q.Z, W = Q.W;
    B.Axis[0] = FVector(1 - 2 * (Y * Y + Z * Z), 2 * (X * Y + Z * W), 2 * (X * Z - Y * W));
    B.Axis[1] = FVector(2 * (X * Y - Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z + X * W));
    B.Axis[2] = FVector(2 * (X * Z + Y * W), 2 * (Y * Z - X * W), 1 - 2 * (X * X + Y * Y));
    return B;
}

double Length(const FVector& V) { return std::hypot(V.X, V.Y, V.Z); }
FVector Swap(const FVector& V) { return FVector(V.X, V.Z, V.Y); }

FRotator BasisRotator(const FBasis& B, bool bSwap)
{
    const FVector X = bSwap ? Swap(B.Axis[0]) : B.Axis[0];
    const FVector Y = bSwap ? Swap(B.Axis[2]) : B.Axis[1];
    const FVector Z = bSwap ? Swap(B.Axis[1]) : B.Axis[2];
    const double Degrees = 180.0 / UE_DOUBLE_PI;
    const double Pitch = std::atan2(X.Z, std::hypot(X.X, X.Y)) * Degrees;
    const double Yaw = std::atan2(X.Y, X.X) * Degrees;
    const FVector SY(-std::sin(Yaw / Degrees), std::cos(Yaw / Degrees), 0);
    const double Roll = std::atan2(Z.X * SY.X + Z.Y * SY.Y + Z.Z * SY.Z, Y.X * SY.X + Y.Y * SY.Y + Y.Z * SY.Z) * Degrees;
    return FRotator(Pitch, Yaw, Roll);
}

const FColumn* FindColumn(const TArray<FColumn>& Columns, const FString& Name, bool bIgnoreCase = false)
{
    return Columns.FindByPredicate([&](const FColumn& C) { return C.Name.Equals(Name, bIgnoreCase ? ESearchCase::IgnoreCase : ESearchCase::CaseSensitive); });
}

bool IsNumeric(const FColumn* Column, int32 Size)
{
    return Column && Column->Type != ETopoTopoAttributeType::String && Column->Size == Size;
}

FVector Vector(const FColumn* Column, int32 Row, FVector Default)
{
    if (!IsNumeric(Column, 3)) return Default;
    const int32 Offset = Row * 3;
    return FVector(Column->Numbers[Offset], Column->Numbers[Offset + 1], Column->Numbers[Offset + 2]);
}

FQuat Quaternion(const FColumn* Column, int32 Row)
{
    const int32 Offset = Row * 4;
    return FQuat(Column->Numbers[Offset], Column->Numbers[Offset + 1], Column->Numbers[Offset + 2], Column->Numbers[Offset + 3]);
}

FBasis PointBasis(const TArray<FColumn>& Columns, int32 Row)
{
    FBasis Basis;
    const FColumn* Orient = FindColumn(Columns, TEXT("orient"));
    if (IsNumeric(Orient, 4)) Basis = QuaternionBasis(Quaternion(Orient, Row));
    else
    {
        const FColumn* Normal = FindColumn(Columns, TEXT("N"));
        if (!Normal) Normal = FindColumn(Columns, TEXT("v"));
        const FVector Direction = Vector(Normal, Row, FVector::ZeroVector);
        const double DirectionLength = Length(Direction);
        // math.ts normalize yields a zero vector when finite components have an infinite norm;
        // lookAtBasis then keeps identity, before the optional rot multiplication.
        if (DirectionLength > 1e-12 && FMath::IsFinite(DirectionLength))
        {
            const FVector Z = Direction / DirectionLength;
            const FVector Up = Vector(FindColumn(Columns, TEXT("up")), Row, FVector(0, 1, 0));
            FVector X = FVector::CrossProduct(Up, Z);
            if (Length(X) < 1e-8) X = FVector::CrossProduct(std::abs(Z.Y) < 0.9 ? FVector(0, 1, 0) : FVector(1, 0, 0), Z);
            const double XLength = Length(X);
            X = XLength > 0 ? X / XLength : FVector::ZeroVector;
            Basis.Axis[0] = X; Basis.Axis[1] = FVector::CrossProduct(Z, X); Basis.Axis[2] = Z;
        }
    }
    const FColumn* Rot = FindColumn(Columns, TEXT("rot"));
    if (IsNumeric(Rot, 4))
    {
        const FBasis B = QuaternionBasis(Quaternion(Rot, Row));
        const FBasis A = Basis;
        for (int32 C = 0; C < 3; ++C)
            for (int32 R = 0; R < 3; ++R)
                Basis.Axis[C][R] = A.Axis[0][R] * B.Axis[C][0] + A.Axis[1][R] * B.Axis[C][1] + A.Axis[2][R] * B.Axis[C][2];
    }
    return Basis;
}

int32 DefaultSeed(uint32 Index)
{
    Index ^= Index >> 16; Index *= 0x7feb352dU;
    Index ^= Index >> 15; Index *= 0x846ca68bU;
    Index ^= Index >> 16;
    return static_cast<int32>(Index >> 1);
}

bool ContainsExact(const TArray<FString>& Names, const FString& Name)
{
    return Names.ContainsByPredicate([&](const FString& Existing) { return Existing.Equals(Name, ESearchCase::CaseSensitive); });
}

bool Selected(const FString& Name, const FTopoTopoStreamOptions& Options)
{
    return (Options.AttributeInclude.IsEmpty() || ContainsExact(Options.AttributeInclude, Name)) && !ContainsExact(Options.AttributeExclude, Name);
}

bool SelectedPart(const FString& Base, const FString& Name, const FTopoTopoStreamOptions& Options)
{
    return (Options.AttributeInclude.IsEmpty() || ContainsExact(Options.AttributeInclude, Base) || ContainsExact(Options.AttributeInclude, Name)) &&
        !ContainsExact(Options.AttributeExclude, Base) && !ContainsExact(Options.AttributeExclude, Name);
}

bool ValidMetadataName(const FString& Name)
{
    // UE 5.8 PCGMetadataAttributeBase::IsValidNameCharacter. Avoid silent sanitization collisions.
    for (TCHAR C : Name)
        if (!(FChar::IsAlpha(C) || FChar::IsDigit(C) || C == TEXT(' ') || C == TEXT('_') || C == TEXT('-') || C == TEXT('/'))) return false;
    return !Name.IsEmpty();
}

bool PCGProperty(const FString& Name)
{
    return Name.Equals(TEXT("Position"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("Rotation"), ESearchCase::IgnoreCase) ||
        Name.Equals(TEXT("Scale"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("Color"), ESearchCase::IgnoreCase) ||
        Name.Equals(TEXT("Density"), ESearchCase::IgnoreCase) || Name.Equals(TEXT("Seed"), ESearchCase::IgnoreCase);
}

bool MakeStream(const TArray<FColumn>& Columns, int32 Count, bool bPCG, const FTopoTopoStreamOptions& Options, FTopoTopoStream& Stream, FString& Error)
{
    const bool bConvert = Options.CoordinateMode == ETopoTopoCoordinateMode::FromTopoTopoYUp;
    if (bPCG && bConvert) return Fail(Error, TEXT("PCG Position/Rotation columns are already Unreal centimetres. Select AsWritten; FromTopoTopoYUp is for native P/orient streams."));
    const FColumn* Position = FindColumn(Columns, bPCG ? TEXT("Position") : TEXT("P"), bPCG);
    if (!IsNumeric(Position, 3)) return Fail(Error, TEXT("Stream requires a numeric three-component Position (PCG CSV) or P (native stream)."));
    const FColumn* Scale = FindColumn(Columns, bPCG ? TEXT("Scale") : TEXT("scale"), bPCG);
    const FColumn* Rotation = bPCG ? FindColumn(Columns, TEXT("Rotation"), true) : nullptr;
    const FColumn* PScale = bPCG ? nullptr : FindColumn(Columns, TEXT("pscale"));
    const FColumn* Trans = bPCG ? nullptr : FindColumn(Columns, TEXT("trans"));
    const FColumn* Density = FindColumn(Columns, Options.DensityColumn.IsEmpty() ? (bPCG ? TEXT("Density") : TEXT("density")) : Options.DensityColumn, bPCG && Options.DensityColumn.IsEmpty());
    const FColumn* Seed = FindColumn(Columns, Options.SeedColumn.IsEmpty() ? (bPCG ? TEXT("Seed") : TEXT("seed")) : Options.SeedColumn, bPCG && Options.SeedColumn.IsEmpty());
    const FColumn* Color = FindColumn(Columns, bPCG ? TEXT("Color") : TEXT("Cd"), bPCG);
    const FColumn* Alpha = bPCG ? nullptr : FindColumn(Columns, TEXT("Alpha"));
    if ((Scale && !IsNumeric(Scale, 3)) || (Rotation && !IsNumeric(Rotation, 3)) || (Trans && !IsNumeric(Trans, 3)) ||
        (PScale && !IsNumeric(PScale, 1)) || (Density && !IsNumeric(Density, 1)) ||
        (Seed && (Seed->Type == ETopoTopoAttributeType::String || (bPCG && Seed->Size != 1))) ||
        (Alpha && Alpha->Type == ETopoTopoAttributeType::Float && Alpha->Size != 1) ||
        (Color && (Color->Type == ETopoTopoAttributeType::String || Color->Size < 3 || Color->Size > 4)))
        return Fail(Error, TEXT("Transform, density, seed or color attribute has the wrong type/tuple size. Positions/scales require 3, scalar properties 1, colors 3 or 4."));
    if ((!Options.SeedColumn.IsEmpty() && !Seed) || (!Options.DensityColumn.IsEmpty() && !Density)) return Fail(Error, TEXT("The configured seed or density column was not found (names are case-sensitive)."));
    for (const TCHAR* Name : {TEXT("orient"), TEXT("rot"), TEXT("N"), TEXT("v"), TEXT("up")})
    {
        const FColumn* Column = bPCG ? nullptr : FindColumn(Columns, Name);
        const int32 Expected = FCString::Strcmp(Name, TEXT("orient")) == 0 || FCString::Strcmp(Name, TEXT("rot")) == 0 ? 4 : 3;
        if (Column && !IsNumeric(Column, Expected)) return Fail(Error, FString::Printf(TEXT("Transform attribute '%s' must have %d numeric components."), Name, Expected));
    }
    TSet<FName> MetadataNames;
    for (const FColumn& Column : Columns)
    {
        if (bPCG && PCGProperty(Column.Name)) continue;
        if (Column.Name.Equals(TEXT("MeshPath"), ESearchCase::IgnoreCase)) return Fail(Error, TEXT("MeshPath is reserved for resolved static mesh paths; rename that input attribute."));
        const int32 Parts = Column.Size > 4 ? Column.Size : 1;
        for (int32 Part = 0; Part < Parts; ++Part)
        {
            const FString Name = Parts == 1 ? Column.Name : FString::Printf(TEXT("%s_%d"), *Column.Name, Part);
            const FName Key(*Name);
            if (!ValidMetadataName(Name) || Key.IsNone() || MetadataNames.Contains(Key)) return Fail(Error, FString::Printf(TEXT("Metadata name '%s' is invalid/reserved or collides case-insensitively with another attribute. PCG names allow letters, digits, space, underscore, hyphen and slash; rename the input attribute."), *Name));
            MetadataNames.Add(Key);
            if (SelectedPart(Column.Name, Name, Options)) Stream.AttributeNames.Add(Name);
        }
    }
    Stream.Rows.Reserve(Count);
    for (int32 RowIndex = 0; RowIndex < Count; ++RowIndex)
    {
        FTopoTopoStreamRow Row;
        FVector P = Vector(Position, RowIndex, FVector::ZeroVector) + Vector(Trans, RowIndex, FVector::ZeroVector);
        FVector S = Vector(Scale, RowIndex, FVector::OneVector);
        if (PScale) S *= PScale->Numbers[RowIndex];
        FRotator R;
        if (bPCG) { const FVector V = Vector(Rotation, RowIndex, FVector::ZeroVector); R = FRotator(V.Y, V.Z, V.X); }
        else R = BasisRotator(PointBasis(Columns, RowIndex), bConvert);
        if (bConvert) { P = Swap(P) * 100.0; S = Swap(S); }
        if (P.ContainsNaN() || S.ContainsNaN() || R.ContainsNaN()) return Fail(Error, FString::Printf(TEXT("Row %d has a transform outside the finite numeric range."), RowIndex + 1));
        Row.Transform = FTransform(R, P, S);
        if (Row.Transform.ContainsNaN()) return Fail(Error, FString::Printf(TEXT("Row %d has a transform outside the finite numeric range."), RowIndex + 1));
        if (Density)
        {
            const double D = Density->Numbers[RowIndex];
            if (std::abs(D) > MAX_flt) return Fail(Error, FString::Printf(TEXT("Row %d density exceeds float range."), RowIndex + 1));
            Row.Density = static_cast<float>(D);
        }
        Row.Seed = DefaultSeed(static_cast<uint32>(RowIndex));
        if (Seed)
        {
            // Math.round uses floor(x + 0.5), including negative half values.
            const double Rounded = std::floor(Seed->Numbers[RowIndex * Seed->Size] + 0.5);
            if (Rounded < MIN_int32 || Rounded > MAX_int32) return Fail(Error, FString::Printf(TEXT("Row %d seed is outside int32 range."), RowIndex + 1));
            Row.Seed = static_cast<int32>(Rounded);
        }
        if (Color)
        {
            const int32 Offset = RowIndex * Color->Size;
            Row.Color = FVector4(Color->Numbers[Offset], Color->Numbers[Offset + 1], Color->Numbers[Offset + 2], bPCG && Color->Size == 4 ? Color->Numbers[Offset + 3] : 1);
        }
        // The native writer consumes Alpha only when its declared type is float.
        // Integer/string Alpha remains ordinary metadata and leaves the default alpha unchanged.
        if (Alpha && Alpha->Type == ETopoTopoAttributeType::Float) Row.Color.W = Alpha->Numbers[RowIndex];
        for (const FColumn& Column : Columns)
        {
            if (bPCG && PCGProperty(Column.Name)) continue;
            const int32 Parts = Column.Size > 4 ? Column.Size : 1;
            for (int32 Part = 0; Part < Parts; ++Part)
            {
                const FString Name = Parts == 1 ? Column.Name : FString::Printf(TEXT("%s_%d"), *Column.Name, Part);
                if (!SelectedPart(Column.Name, Name, Options)) continue;
                FTopoTopoAttributeValue Value;
                Value.Type = Column.Type;
                const int32 Offset = RowIndex * Column.Size + Part;
                if (Column.Type == ETopoTopoAttributeType::String) Value.StringValue = Column.Strings[RowIndex];
                else if (Column.Size == 1 || Parts > 1)
                {
                    Value.FloatValue = Column.Numbers[Offset];
                    if (Column.Type == ETopoTopoAttributeType::Integer) Value.IntValue = static_cast<int64>(Value.FloatValue);
                }
                else
                {
                    Value.Type = Column.Size == 2 ? ETopoTopoAttributeType::Vector2 : Column.Size == 3 ? ETopoTopoAttributeType::Vector : ETopoTopoAttributeType::Vector4;
                    for (int32 C = 0; C < Column.Size; ++C) Value.VectorValue[C] = Column.Numbers[Offset + C];
                }
                Row.Attributes.Add(Name, MoveTemp(Value));
            }
        }
        // Mapping still works when Mesh itself is filtered; MeshPath can be selected independently.
        const FColumn* Mesh = FindColumn(Columns, TEXT("Mesh"));
        if (Mesh && Mesh->Type != ETopoTopoAttributeType::String) return Fail(Error, TEXT("Mesh must be a string attribute."));
        if (Mesh && Selected(TEXT("MeshPath"), Options))
        {
            const FString& Name = Mesh->Strings[RowIndex];
            const FSoftObjectPath* Mapping = Options.MeshMapping.Find(Name);
            if (Mapping && !Mapping->IsNull())
            {
                FTopoTopoAttributeValue Value;
                Value.Type = ETopoTopoAttributeType::String;
                Value.StringValue = Mapping->ToString();
                Row.Attributes.Add(TEXT("MeshPath"), MoveTemp(Value));
                Stream.AttributeNames.AddUnique(TEXT("MeshPath"));
            }
            else
            {
                FTopoTopoAttributeValue Value;
                Value.Type = ETopoTopoAttributeType::String;
                Row.Attributes.Add(TEXT("MeshPath"), MoveTemp(Value));
                Stream.AttributeNames.AddUnique(TEXT("MeshPath"));
                Stream.Warnings.AddUnique(FString::Printf(TEXT("Mesh '%s' has no mapping. Import its GLB and provide a mapping or sibling .meshes.json plus Mesh Folder."), *Name));
            }
        }
        Stream.Rows.Add(MoveTemp(Row));
    }
    Stream.AttributeNames.Sort();
    return true;
}

bool ReadSidecar(const FString& Path, FTopoTopoStreamOptions& Options, FString& Error)
{
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Path)) return Fail(Error, TEXT("Could not read mesh sidecar: ") + Path);
    TSharedPtr<FJsonObject> Root;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid()) return Fail(Error, TEXT("Invalid mesh sidecar JSON: ") + Path);
    FString Format;
    double Version = 0;
    const TArray<TSharedPtr<FJsonValue>>* Meshes = nullptr;
    if (!Root->TryGetStringField(TEXT("format"), Format) || (Format != TEXT("topotopo-instance-meshes") && Format != TEXT("polyforge-instance-meshes")) || !Root->TryGetNumberField(TEXT("version"), Version) || Version != 1 || !Root->TryGetArrayField(TEXT("meshes"), Meshes))
        return Fail(Error, TEXT("Mesh sidecar must use format topotopo-instance-meshes (legacy polyforge-instance-meshes is accepted), version 1, meshes array: ") + Path);
    FString Folder = Options.MeshFolder;
    Folder.RemoveFromEnd(TEXT("/"));
    if (!Folder.StartsWith(TEXT("/Game/")) && Folder != TEXT("/Game")) return Fail(Error, TEXT("Mesh Folder must be a /Game/... Unreal content folder."));
    TSet<FString> Names;
    for (const TSharedPtr<FJsonValue>& Entry : *Meshes)
    {
        const TSharedPtr<FJsonObject>* Object = nullptr;
        FString Name;
        if (!Entry->TryGetObject(Object) || !(*Object)->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty()) return Fail(Error, TEXT("Mesh sidecar entries need nonempty names: ") + Path);
        if (Names.Contains(Name)) return Fail(Error, TEXT("Duplicate mesh sidecar name: ") + Name);
        Names.Add(Name);
        if (Options.MeshMapping.Contains(Name)) continue;
        // Filename sanitization belongs to the importing pipeline. Do not silently invent a different name.
        for (TCHAR C : Name)
            if (!(FChar::IsAlnum(C) || C == TEXT('_'))) return Fail(Error, FString::Printf(TEXT("Mesh '%s' is not an asset-safe name. Add its exact imported asset to Mesh Mapping."), *Name));
        Options.MeshMapping.Add(Name, FSoftObjectPath(Folder / Name + TEXT(".") + Name));
    }
    return true;
}
}

FString TopoTopoStream::ResolveFilePath(const FString& FilePath)
{
    return FPaths::ConvertRelativePathToFull(FPaths::IsRelative(FilePath) ? FPaths::Combine(FPaths::ProjectDir(), FilePath) : FilePath);
}

bool TopoTopoStream::ParseText(const FString& Text, bool bJson, const FTopoTopoStreamOptions& Options, FTopoTopoStream& OutStream, FString& OutError)
{
    OutStream = FTopoTopoStream();
    OutError.Empty();
    TArray<FColumn> Columns;
    int32 Count = 0;
    bool bPCG = false;
    FTopoTopoStream Parsed;
    if (!(bJson ? JSONColumns(Text, Columns, Count, OutError) : CSVColumns(Text, Columns, Count, bPCG, Parsed.Warnings, OutError))) return false;
    if (!MakeStream(Columns, Count, bPCG, Options, Parsed, OutError)) return false;
    OutStream = MoveTemp(Parsed);
    return true;
}

bool TopoTopoStream::LoadFile(const FString& FilePath, const FTopoTopoStreamOptions& Options, FTopoTopoStream& OutStream, FString& OutError)
{
    OutStream = FTopoTopoStream();
    OutError.Empty();
    if (FilePath.TrimStartAndEnd().IsEmpty()) return Fail(OutError, TEXT("Set File Path to a PCG CSV or points.json stream."));
    const FString Path = ResolveFilePath(FilePath);
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Path)) return Fail(OutError, TEXT("Cannot read point stream: ") + Path);
    FTopoTopoStreamOptions Resolved = Options;
    const FString Sidecar = FPaths::GetPath(Path) / (FPaths::GetBaseFilename(Path) + TEXT(".meshes.json"));
    const FString InstancesSidecar = FPaths::GetPath(Path) / TEXT("instances.meshes.json");
    const FString SidecarPath = IFileManager::Get().FileExists(*Sidecar) ? Sidecar : InstancesSidecar;
    if (IFileManager::Get().FileExists(*SidecarPath) && !ReadSidecar(SidecarPath, Resolved, OutError)) return false;
    if (!ParseText(Text, FPaths::GetExtension(Path).Equals(TEXT("json"), ESearchCase::IgnoreCase), Resolved, OutStream, OutError))
    {
        OutError = Path + TEXT(": ") + OutError;
        return false;
    }
    return true;
}

FRotator TopoTopoStream::UnrealRotator(const FQuat& Orientation)
{
    return BasisRotator(QuaternionBasis(Orientation), true);
}
